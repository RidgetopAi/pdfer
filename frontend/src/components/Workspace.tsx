import { useEffect, useCallback, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  fetchDocument,
  fetchObjects,
  fetchUndoState,
  fetchReviewStats,
  fetchExtractions,
  fetchTrainingStats,
  submitEdits,
  undoAction,
  redoAction,
  describeDocument,
  extractDocument,
  assembleDocument,
  bundleUrl,
  trainingExportUrl,
  connectWebSocket,
  type EditAction,
} from "../api/client";
import { useReviewStore } from "../store/reviewStore";
import { PageList } from "./PageList";
import { ReviewCanvas } from "./ReviewCanvas";
import { ObjectInspector } from "./ObjectInspector";
import { QueueView } from "./QueueView";

interface Props {
  documentId: string;
  onBack: () => void;
}

export function Workspace({ documentId, onBack }: Props) {
  const {
    currentPageIndex,
    setCurrentPageIndex,
    selectedObjectIds,
    deselectAll,
    mode,
    setMode,
    toast,
    showToast,
    clearToast,
  } = useReviewStore();

  const { data: doc, refetch: refetchDoc } = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => fetchDocument(documentId),
  });

  const { data: objectsData, refetch: refetchObjects } = useQuery({
    queryKey: ["objects", documentId],
    queryFn: () => fetchObjects(documentId),
  });

  const { data: undoState, refetch: refetchUndo } = useQuery({
    queryKey: ["undo-state", documentId],
    queryFn: () => fetchUndoState(documentId),
  });

  const { data: stats, refetch: refetchStats } = useQuery({
    queryKey: ["review-stats", documentId],
    queryFn: () => fetchReviewStats(documentId),
  });

  const { data: extractionsData, refetch: refetchExtractions } = useQuery({
    queryKey: ["extractions", documentId],
    queryFn: () => fetchExtractions(documentId),
    enabled: (doc?.current_stage ?? 0) >= 2,
  });

  const [extractionProgress, setExtractionProgress] = useState<string | null>(null);
  const [describeProgress, setDescribeProgress] = useState<string | null>(null);
  const [showQueueView, setShowQueueView] = useState(false);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  const [markdownContent, setMarkdownContent] = useState<string | null>(null);

  const { data: trainingStats, refetch: refetchTraining } = useQuery({
    queryKey: ["training-stats"],
    queryFn: fetchTrainingStats,
  });

  // Invalidate all review data — includes the document itself so
  // current_stage/stage_status flips drive the stage-gated buttons.
  const invalidateAll = useCallback(() => {
    refetchDoc();
    refetchObjects();
    refetchUndo();
    refetchStats();
    refetchExtractions();
  }, [refetchDoc, refetchObjects, refetchUndo, refetchStats, refetchExtractions]);

  // WebSocket for real-time updates
  useEffect(() => {
    const ws = connectWebSocket(documentId, (event, data) => {
      if (event === "object.edited") {
        invalidateAll();
      }
      if (event === "object.described") {
        const d = data as { progress?: string };
        if (d?.progress) {
          setDescribeProgress(`Describing... ${d.progress}`);
        }
        refetchObjects();
      }
      if (event === "object.description_edited") {
        refetchObjects();
        refetchTraining();
      }
      if (event === "object.extracted") {
        const d = data as { progress?: string };
        if (d?.progress) {
          setExtractionProgress(`Extracting... ${d.progress}`);
        }
        refetchExtractions();
      }
      if (event === "document.assembled") {
        invalidateAll();
      }
      // Stage transitions — refresh everything so the stage-gated buttons
      // (Describe / Extract / Assemble / Download) flip live.
      if (event === "stage.completed") {
        invalidateAll();
      }
    });
    return () => ws.close();
  }, [documentId, invalidateAll, refetchExtractions, refetchObjects, refetchTraining]);

  // Edit mutation
  const editMutation = useMutation({
    mutationFn: (edits: EditAction[]) => submitEdits(documentId, edits),
    onSuccess: (result) => {
      showToast(result.description);
      invalidateAll();
    },
  });

  // Undo mutation
  const undoMutation = useMutation({
    mutationFn: () => undoAction(documentId),
    onSuccess: (result) => {
      showToast(`Undo: ${result.description}`, "undo");
      invalidateAll();
    },
  });

  // Redo mutation
  const redoMutation = useMutation({
    mutationFn: () => redoAction(documentId),
    onSuccess: (result) => {
      showToast(`Redo: ${result.description}`, "redo");
      invalidateAll();
    },
  });

  // Describe mutation — Stage 1.5: runs Gemma on every detected object
  // BEFORE review. The resulting descriptions are shown in the inspector so
  // the reviewer can correct them in place (Loop B Phase 1 training signal).
  const describeMutation = useMutation({
    mutationFn: (useLlm: boolean) => describeDocument(documentId, useLlm, false),
    onMutate: () => setDescribeProgress("Starting description..."),
    onSuccess: (result) => {
      setDescribeProgress(null);
      showToast(
        `Described ${result.total_described} objects` +
          (result.failed ? `, ${result.failed} failed` : "") +
          (result.skipped ? `, ${result.skipped} skipped` : ""),
      );
      invalidateAll();
    },
    onError: (err: Error) => {
      setDescribeProgress(null);
      showToast(`Describe failed: ${err.message}`);
    },
  });

  // Extract mutation — `useLlm` controls whether Gemma is invoked.
  // Turn it off to run the pdfplumber-only path when the LLM stack
  // (transformers/bitsandbytes/GPU) isn't available.
  const extractMutation = useMutation({
    mutationFn: (useLlm: boolean) => extractDocument(documentId, useLlm),
    onMutate: (useLlm) => {
      setExtractionProgress(
        useLlm ? "Starting extraction..." : "Starting extraction (no LLM)..."
      );
    },
    onSuccess: (result) => {
      setExtractionProgress(null);
      showToast(`Extracted ${result.total_extracted} objects`);
      invalidateAll();
    },
    onError: (err: Error) => {
      setExtractionProgress(null);
      showToast(`Extraction failed: ${err.message}`);
    },
  });

  // Assemble mutation
  const assembleMutation = useMutation({
    mutationFn: () => assembleDocument(documentId),
    onSuccess: (result) => {
      setMarkdownContent(result.markdown);
      setShowMarkdownPreview(true);
      showToast(`Assembled ${result.total_objects} objects, ${result.asset_count} assets`);
      invalidateAll();
    },
    onError: (err: Error) => {
      showToast(`Assembly failed: ${err.message}`);
    },
  });

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture if an input/textarea is focused
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl+Z: Undo
      if (ctrl && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        if (undoState?.can_undo) undoMutation.mutate();
        return;
      }
      // Ctrl+Shift+Z: Redo
      if (ctrl && e.shiftKey && e.key === "z") {
        e.preventDefault();
        if (undoState?.can_redo) redoMutation.mutate();
        return;
      }

      // Escape: deselect or cancel draw mode
      if (e.key === "Escape") {
        deselectAll();
        setMode("select");
        return;
      }

      // D: toggle draw mode
      if (e.key === "d" || e.key === "D") {
        setMode(mode === "draw" ? "select" : "draw");
        return;
      }

      // Enter/C: confirm selected
      if ((e.key === "Enter" || e.key === "c") && selectedObjectIds.size > 0) {
        const edits: EditAction[] = [...selectedObjectIds].map((id) => ({
          action: "confirm",
          object_id: id,
        }));
        editMutation.mutate(edits);
        deselectAll();
        return;
      }

      // X: reject selected
      if (e.key === "x" && selectedObjectIds.size > 0) {
        const edits: EditAction[] = [...selectedObjectIds].map((id) => ({
          action: "reject",
          object_id: id,
        }));
        editMutation.mutate(edits);
        deselectAll();
        return;
      }

      // Delete/Backspace: delete selected
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedObjectIds.size > 0
      ) {
        const edits: EditAction[] = [...selectedObjectIds].map((id) => ({
          action: "delete",
          object_id: id,
        }));
        editMutation.mutate(edits);
        deselectAll();
        return;
      }

      // Tab: cycle objects by reading order
      if (e.key === "Tab" && currentPageObjects.length > 0) {
        e.preventDefault();
        const currentIds = [...selectedObjectIds];
        const sortedObjects = [...currentPageObjects].sort(
          (a, b) => (a.reading_order ?? 999) - (b.reading_order ?? 999)
        );
        if (currentIds.length === 0) {
          useReviewStore
            .getState()
            .selectObject(sortedObjects[0].id);
          return;
        }
        const currentIndex = sortedObjects.findIndex(
          (o) => o.id === currentIds[0]
        );
        const nextIndex = e.shiftKey
          ? (currentIndex - 1 + sortedObjects.length) % sortedObjects.length
          : (currentIndex + 1) % sortedObjects.length;
        useReviewStore
          .getState()
          .selectObject(sortedObjects[nextIndex].id);
        return;
      }

      // F1-F9: quick relabel
      const fKeyLabels = [
        "paragraph",
        "section_heading",
        "title",
        "table",
        "figure",
        "list",
        "caption",
        "footnote",
        "formula",
      ];
      const fKeyMatch = e.key.match(/^F(\d)$/);
      if (fKeyMatch && selectedObjectIds.size > 0) {
        const fIndex = parseInt(fKeyMatch[1]) - 1;
        if (fIndex >= 0 && fIndex < fKeyLabels.length) {
          e.preventDefault();
          const edits: EditAction[] = [...selectedObjectIds].map((id) => ({
            action: "relabel",
            object_id: id,
            label: fKeyLabels[fIndex],
          }));
          editMutation.mutate(edits);
          return;
        }
      }

      // Page navigation
      if (e.key === "PageDown" || e.key === "ArrowRight") {
        if (doc && currentPageIndex < doc.pages.length - 1) {
          setCurrentPageIndex(currentPageIndex + 1);
          deselectAll();
        }
        return;
      }
      if (e.key === "PageUp" || e.key === "ArrowLeft") {
        if (currentPageIndex > 0) {
          setCurrentPageIndex(currentPageIndex - 1);
          deselectAll();
        }
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    mode,
    selectedObjectIds,
    currentPageIndex,
    doc,
    undoState,
    editMutation,
    undoMutation,
    redoMutation,
    deselectAll,
    setMode,
    setCurrentPageIndex,
  ]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(clearToast, 4000);
    return () => clearTimeout(timer);
  }, [toast, clearToast]);

  if (!doc || !objectsData) return <p style={{ color: "#94a3b8" }}>Loading workspace...</p>;

  // Current page data
  const currentPage = doc.pages[currentPageIndex];
  const pageObjectsEntry = objectsData.pages.find(
    (p) => p.page_number === currentPage?.page_number
  );
  const currentPageObjects = pageObjectsEntry?.objects ?? [];

  // Selected objects detail
  const selectedObjects = currentPageObjects.filter((o) =>
    selectedObjectIds.has(o.id)
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#020617",
        color: "#e2e8f0",
        overflow: "hidden",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          borderBottom: "1px solid #1e293b",
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "1px solid #475569",
            color: "#94a3b8",
            padding: "4px 12px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Back
        </button>
        <strong style={{ fontSize: 14 }}>{doc.filename}</strong>

        {/* Pipeline progress */}
        <div style={{ display: "flex", gap: 4, marginLeft: 12 }}>
          {["Ingest", "Detect", "Review", "Extract", "Assemble"].map(
            (name, i) => (
              <span
                key={name}
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 3,
                  background:
                    i < doc.current_stage
                      ? "#166534"
                      : i === doc.current_stage
                        ? "#854d0e"
                        : "#1e293b",
                  color: i <= doc.current_stage ? "#e2e8f0" : "#64748b",
                }}
              >
                {name}
              </span>
            )
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Review stats */}
        {stats && (
          <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#94a3b8" }}>
            <span style={{ color: "#22c55e" }}>{stats.confirmed} confirmed</span>
            <span style={{ color: "#ef4444" }}>{stats.rejected} rejected</span>
            <span>{stats.unreviewed} unreviewed</span>
            <span style={{ color: "#64748b" }}>
              {stats.pages_complete}/{stats.pages_total} pages done
            </span>
          </div>
        )}

        {/* Describe buttons — Stage 1.5. Runs Gemma on every detected object
            before human review so the reviewer sees the AI's read inline. */}
        {stats && doc.current_stage >= 1 && doc.current_stage < 2 && (
          <>
            <button
              onClick={() => describeMutation.mutate(true)}
              disabled={describeMutation.isPending}
              style={{
                background: "#7c2d12",
                border: "1px solid #fdba74",
                color: "#fff7ed",
                padding: "4px 12px",
                borderRadius: 4,
                cursor: describeMutation.isPending ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
              title="Run Gemma on every object so the reviewer can validate or correct each read"
            >
              {describeMutation.isPending ? "Describing..." : "Describe (Gemma)"}
            </button>
            <button
              onClick={() => describeMutation.mutate(false)}
              disabled={describeMutation.isPending}
              style={{
                background: "#1e293b",
                border: "1px solid #475569",
                color: "#cbd5e1",
                padding: "4px 10px",
                borderRadius: 4,
                cursor: describeMutation.isPending ? "not-allowed" : "pointer",
                fontSize: 11,
              }}
              title="Describe with stub text — useful when Gemma isn't installed"
            >
              Describe (stub)
            </button>
          </>
        )}

        {describeProgress && (
          <span style={{ fontSize: 11, color: "#fdba74" }}>{describeProgress}</span>
        )}

        {/* Extract buttons — enabled only when no unreviewed objects remain.
            Two variants: with Gemma (recommended when installed), and a
            pdfplumber-only path that skips the LLM entirely. */}
        {stats && doc.current_stage < 2 && (
          <>
            <button
              onClick={() => extractMutation.mutate(true)}
              disabled={stats.unreviewed > 0 || extractMutation.isPending}
              style={{
                background: stats.unreviewed === 0 ? "#166534" : "#1e293b",
                border:
                  "1px solid " +
                  (stats.unreviewed === 0 ? "#22c55e" : "#475569"),
                color: stats.unreviewed === 0 ? "#e2e8f0" : "#64748b",
                padding: "4px 12px",
                borderRadius: 4,
                cursor: stats.unreviewed === 0 ? "pointer" : "not-allowed",
                fontSize: 12,
                fontWeight: 600,
              }}
              title={
                stats.unreviewed > 0
                  ? `Review all objects first (${stats.unreviewed} unreviewed)`
                  : "Run extraction on all confirmed objects (uses Gemma for hard cases)"
              }
            >
              {extractMutation.isPending ? "Extracting..." : "Extract"}
            </button>
            <button
              onClick={() => extractMutation.mutate(false)}
              disabled={stats.unreviewed > 0 || extractMutation.isPending}
              style={{
                background: "#1e293b",
                border:
                  "1px solid " +
                  (stats.unreviewed === 0 ? "#64748b" : "#334155"),
                color: stats.unreviewed === 0 ? "#cbd5e1" : "#64748b",
                padding: "4px 10px",
                borderRadius: 4,
                cursor: stats.unreviewed === 0 ? "pointer" : "not-allowed",
                fontSize: 11,
              }}
              title={
                stats.unreviewed > 0
                  ? `Review all objects first (${stats.unreviewed} unreviewed)`
                  : "Run extraction without calling Gemma — use when the LLM stack isn't installed"
              }
            >
              Extract (no LLM)
            </button>
          </>
        )}

        {/* Extraction progress indicator */}
        {extractionProgress && (
          <span style={{ fontSize: 11, color: "#a78bfa" }}>{extractionProgress}</span>
        )}

        {/* Extraction complete badge */}
        {extractionsData && extractionsData.total > 0 && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 3,
              background: "#14532d",
              color: "#4ade80",
              border: "1px solid #166534",
            }}
          >
            {extractionsData.total} extracted
          </span>
        )}

        {/* Assemble button — enabled after extraction is complete */}
        {doc.current_stage >= 2 && doc.current_stage < 4 && (
          <button
            onClick={() => assembleMutation.mutate()}
            disabled={assembleMutation.isPending}
            style={{
              background: "#1e40af",
              border: "1px solid #3b82f6",
              color: "#e2e8f0",
              padding: "4px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {assembleMutation.isPending ? "Assembling..." : "Assemble"}
          </button>
        )}

        {/* Download bundle button — after assembly */}
        {doc.current_stage >= 4 && (
          <a
            href={bundleUrl(documentId)}
            download
            style={{
              background: "#166534",
              border: "1px solid #22c55e",
              color: "#e2e8f0",
              padding: "4px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            Download Bundle
          </a>
        )}

        {/* Markdown preview toggle — after assembly */}
        {markdownContent && (
          <button
            onClick={() => setShowMarkdownPreview(!showMarkdownPreview)}
            style={{
              background: showMarkdownPreview ? "#475569" : "#1e293b",
              border: "1px solid #475569",
              color: "#e2e8f0",
              padding: "4px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {showMarkdownPreview ? "Hide Preview" : "Show Preview"}
          </button>
        )}

        {/* Queue View toggle */}
        <button
          onClick={() => setShowQueueView(!showQueueView)}
          style={{
            background: showQueueView ? "#475569" : "#1e293b",
            border: "1px solid #475569",
            color: "#e2e8f0",
            padding: "4px 12px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {showQueueView ? "Canvas View" : "Queue View"}
        </button>

        {/* Corrections counter (compounding intelligence signal) */}
        {undoState && undoState.total_edits > 0 && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 3,
              background: "#1e1b4b",
              color: "#a78bfa",
              border: "1px solid #4c1d95",
            }}
            title="Total corrections made — these improve future extraction quality"
          >
            {undoState.total_edits} corrections
          </span>
        )}

        {/* Training corpus counter — shows Loop B Phase 1 tuples accumulating */}
        {trainingStats && trainingStats.total > 0 && (
          <a
            href={trainingExportUrl()}
            download
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 3,
              background: trainingStats.ready_for_training ? "#14532d" : "#1e1b4b",
              color: trainingStats.ready_for_training ? "#4ade80" : "#a78bfa",
              border:
                "1px solid " +
                (trainingStats.ready_for_training ? "#166534" : "#4c1d95"),
              textDecoration: "none",
            }}
            title={
              trainingStats.ready_for_training
                ? "Training corpus ready for LoRA (>= 200 tuples). Click to download JSONL."
                : `${trainingStats.total} training tuples so far. Need 200 for LoRA Phase 2.`
            }
          >
            {trainingStats.total} tuples
            {trainingStats.ready_for_training && " ✓"}
          </a>
        )}

        {/* Mode indicator */}
        {mode === "draw" && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 3,
              background: "#7c2d12",
              color: "#fdba74",
            }}
          >
            DRAW MODE (Esc to exit)
          </span>
        )}
      </div>

      {/* Three-panel layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left: Page list */}
        <div
          style={{
            width: 140,
            borderRight: "1px solid #1e293b",
            overflowY: "auto",
            flexShrink: 0,
          }}
        >
          <PageList
            documentId={documentId}
            pages={doc.pages}
            objectsData={objectsData}
            currentPageIndex={currentPageIndex}
            onSelectPage={(i) => {
              setCurrentPageIndex(i);
              deselectAll();
            }}
          />
        </div>

        {/* Center: Canvas / Queue View / Markdown Preview */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            background: "#0a0a0a",
          }}
        >
          {showQueueView ? (
            <QueueView
              documentId={documentId}
              onClose={() => setShowQueueView(false)}
              onNavigateToObject={(pageNumber, objectId) => {
                const pageIndex = doc.pages.findIndex(
                  (p) => p.page_number === pageNumber
                );
                if (pageIndex >= 0) {
                  setCurrentPageIndex(pageIndex);
                  useReviewStore.getState().selectObject(objectId);
                  setShowQueueView(false);
                }
              }}
            />
          ) : showMarkdownPreview && markdownContent ? (
            <div
              className="markdown-preview"
              style={{
                padding: 24,
                maxWidth: 800,
                margin: "0 auto",
                fontSize: 14,
                lineHeight: 1.6,
                color: "#e2e8f0",
                overflowY: "auto",
                flex: 1,
              }}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ src, alt }) => {
                    const absolute =
                      src && src.startsWith("assets/")
                        ? `http://localhost:8000/${src}`
                        : src;
                    return (
                      <img
                        src={absolute}
                        alt={alt ?? ""}
                        style={{
                          maxWidth: "100%",
                          border: "1px solid #1e293b",
                          borderRadius: 4,
                        }}
                      />
                    );
                  },
                  table: ({ children }) => (
                    <table
                      style={{
                        borderCollapse: "collapse",
                        width: "100%",
                        margin: "16px 0",
                      }}
                    >
                      {children}
                    </table>
                  ),
                  th: ({ children }) => (
                    <th
                      style={{
                        border: "1px solid #334155",
                        padding: "6px 10px",
                        background: "#1e293b",
                        textAlign: "left",
                      }}
                    >
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td
                      style={{
                        border: "1px solid #334155",
                        padding: "6px 10px",
                      }}
                    >
                      {children}
                    </td>
                  ),
                  code: ({ children }) => (
                    <code
                      style={{
                        background: "#0f172a",
                        padding: "1px 6px",
                        borderRadius: 3,
                        fontFamily: "monospace",
                        fontSize: 13,
                      }}
                    >
                      {children}
                    </code>
                  ),
                }}
              >
                {markdownContent}
              </ReactMarkdown>
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                justifyContent: "center",
                alignItems: "flex-start",
                padding: 16,
              }}
            >
              {currentPage && (
                <ReviewCanvas
                  documentId={documentId}
                  page={currentPage}
                  objects={currentPageObjects}
                  selectedIds={selectedObjectIds}
                  mode={mode}
                  onEdit={(edits) => editMutation.mutate(edits)}
                />
              )}
            </div>
          )}
        </div>

        {/* Right: Inspector */}
        <div
          style={{
            width: 280,
            borderLeft: "1px solid #1e293b",
            overflowY: "auto",
            flexShrink: 0,
          }}
        >
          <ObjectInspector
            objects={selectedObjects}
            onEdit={(edits) => editMutation.mutate(edits)}
            autoConfirmThreshold={0.9}
            onAutoConfirm={(threshold) =>
              editMutation.mutate([
                { action: "auto_confirm", threshold },
              ])
            }
            stats={stats ?? undefined}
            allPageObjects={objectsData.pages}
            onNavigateToObject={(pageNumber, objectId) => {
              const pageIndex = doc.pages.findIndex(
                (p) => p.page_number === pageNumber
              );
              if (pageIndex >= 0) {
                setCurrentPageIndex(pageIndex);
                useReviewStore.getState().selectObject(objectId);
              }
            }}
          />
        </div>
      </div>

      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 16px",
          borderTop: "1px solid #1e293b",
          fontSize: 12,
          color: "#64748b",
          flexShrink: 0,
        }}
      >
        <span>
          Page {currentPageIndex + 1}/{doc.pages.length} |{" "}
          {currentPageObjects.length} objects
        </span>
        <span>
          {undoState?.can_undo
            ? `Last: ${undoState.undo_description} (Ctrl+Z to undo)`
            : "Nothing to undo"}
        </span>
        <span>
          Tab: cycle | Enter: confirm | X: reject | D: draw | F1-F9: relabel
        </span>
      </div>

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 40,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#1e293b",
            border: "1px solid #475569",
            borderRadius: 8,
            padding: "10px 20px",
            color: "#e2e8f0",
            fontSize: 14,
            display: "flex",
            alignItems: "center",
            gap: 12,
            zIndex: 1000,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          <span>{toast.message}</span>
          {toast.action === "undo" && undoState?.can_redo && (
            <button
              onClick={() => redoMutation.mutate()}
              style={{
                background: "#3b82f6",
                border: "none",
                color: "#fff",
                padding: "3px 10px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Redo
            </button>
          )}
          {toast.action !== "undo" && undoState?.can_undo && (
            <button
              onClick={() => undoMutation.mutate()}
              style={{
                background: "#475569",
                border: "none",
                color: "#e2e8f0",
                padding: "3px 10px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
