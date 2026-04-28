import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  assembleDocument,
  bundleUrl,
  describeDocument,
  extractDocument,
  fetchDocument,
  fetchObjects,
  fetchReviewStats,
  fetchTrainingStats,
  trainingExportUrl,
  type DetectedObject,
} from "../../api/client";
import { useReviewStore } from "../../store/reviewStore";
import { useDocumentEvents } from "../../hooks/useDocumentEvents";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useObjectEdits } from "../../hooks/useObjectEdits";
import { Button, StatusPill } from "../../design";
import { StageRail } from "./StageRail";
import { PageThumbs } from "./PageThumbs";
import { PdfStage } from "./PdfStage";
import { ObjectInspector } from "./ObjectInspector";
import { AIReadPanel } from "./AIReadPanel";
import { AutoConfirmPanel } from "./AutoConfirmPanel";
import { OriginalThumb } from "./OriginalThumb";
import { DiffView } from "./DiffView";
import { ReviewActionBar } from "./ReviewActionBar";
import { PipelineProgress, type PipelinePhase } from "./PipelineProgress";
import { QueueView } from "./QueueView";
import { ToastHost } from "./Toast";
import styles from "./Review.module.css";

export function Review() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const currentPageIndex = useReviewStore((s) => s.currentPageIndex);
  const setCurrentPageIndex = useReviewStore((s) => s.setCurrentPageIndex);
  const selectedIds = useReviewStore((s) => s.selectedObjectIds);
  const deselectAll = useReviewStore((s) => s.deselectAll);
  const showToast = useReviewStore((s) => s.showToast);
  const viewMode = useReviewStore((s) => s.viewMode);
  const setViewMode = useReviewStore((s) => s.setViewMode);
  const mode = useReviewStore((s) => s.mode);
  const setMode = useReviewStore((s) => s.setMode);
  const userZoom = useReviewStore((s) => s.userZoom);
  const zoomIn = useReviewStore((s) => s.zoomIn);
  const zoomOut = useReviewStore((s) => s.zoomOut);
  const resetZoom = useReviewStore((s) => s.resetZoom);
  const queryClient = useQueryClient();

  const docQuery = useQuery({
    queryKey: ["document", id],
    queryFn: () => fetchDocument(id!),
    enabled: Boolean(id),
  });

  const objectsQuery = useQuery({
    queryKey: ["objects", id],
    queryFn: () => fetchObjects(id!),
    enabled: Boolean(id) && (docQuery.data?.current_stage ?? 0) >= 1,
  });

  const reviewStatsQuery = useQuery({
    queryKey: ["reviewStats", id],
    queryFn: () => fetchReviewStats(id!),
    enabled: Boolean(id) && (docQuery.data?.current_stage ?? 0) >= 1,
  });

  // Cross-document training corpus stats. Used for the "N tuples" pill in
  // the top bar — clickable when ready_for_training (>= 200) to download the
  // JSONL. Refetch on a slow cadence; tuples accrue per-edit but the user
  // doesn't need second-by-second freshness.
  const trainingStatsQuery = useQuery({
    queryKey: ["trainingStats"],
    queryFn: fetchTrainingStats,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Live extracted-region counter, fed by the per-object `object.extracted`
  // WS events so the pipeline progress card can show "23 / 89 regions".
  // Resets whenever a new pipeline run starts.
  const [extractedCount, setExtractedCount] = useState(0);

  // Live updates — invalidates relevant queries on backend events. We also
  // tap into the same stream to count `object.extracted` events for the
  // pipeline progress UI.
  useDocumentEvents(id, {
    onEvent: (event) => {
      if (event === "object.extracted") {
        setExtractedCount((n) => n + 1);
      } else if (event === "stage.completed") {
        // A stage finished — the next stage will reset the counter via
        // pipelineStarting below.
        setExtractedCount(0);
      }
    },
  });

  const edits = useObjectEdits(id);

  // Local "starting" flag covers the moment between user click and the first
  // backend WebSocket update flipping stage_status to "running". Without it
  // the pipeline overlay would flicker off after click.
  const [pipelineStarting, setPipelineStarting] = useState(false);

  const extractMutation = useMutation({
    mutationFn: () => extractDocument(id!, true),
    onMutate: () => {
      setExtractedCount(0);
      setPipelineStarting(true);
      showToast("Extraction started…");
    },
    onSuccess: () => {
      // Backend extract is sync — by the time this resolves stage_status
      // has already flipped to complete on the server. Kick off assemble
      // immediately; the doc query will refetch from the broadcast.
      queryClient.invalidateQueries({ queryKey: ["document", id] });
      queryClient.invalidateQueries({ queryKey: ["reviewStats", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      assembleMutation.mutate();
    },
    onError: (e: Error) => {
      setPipelineStarting(false);
      showToast(`Extraction failed: ${e.message}`);
    },
  });

  const assembleMutation = useMutation({
    mutationFn: () => assembleDocument(id!),
    onMutate: () => {
      showToast("Assembling markdown…");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document", id] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      // Don't drop the overlay yet — let the stage.completed broadcast
      // (which sets current_stage=4) drive the transition so the auto-
      // navigate-to-Dashboard effect fires consistently.
    },
    onError: (e: Error) => {
      setPipelineStarting(false);
      showToast(`Assembly failed: ${e.message}`);
    },
  });

  // Clear the "starting" flag once the backend confirms a running or
  // complete state for the post-review stages — at that point the doc
  // query is the source of truth.
  useEffect(() => {
    if (!docQuery.data) return;
    const s = docQuery.data.current_stage;
    const status = docQuery.data.stage_status;
    if (s >= 2 || (s === 2 && status === "running") || (s === 3 && status === "running")) {
      setPipelineStarting(false);
    }
  }, [docQuery.data?.current_stage, docQuery.data?.stage_status]);

  const describeMutation = useMutation({
    mutationFn: () => describeDocument(id!, true, false),
    onMutate: () => showToast("Running Gemma on every region…"),
    onSuccess: (result) => {
      const parts = [`Described ${result.total_described}`];
      if (result.failed) parts.push(`${result.failed} failed`);
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      showToast(parts.join(" · "));
      queryClient.invalidateQueries({ queryKey: ["objects", id] });
      queryClient.invalidateQueries({ queryKey: ["reviewStats", id] });
    },
    onError: (err: Error) => showToast(`Run Gemma failed: ${err.message}`),
  });

  const doc = docQuery.data;
  const pages = doc?.pages ?? [];
  const activePage = pages[Math.min(currentPageIndex, Math.max(0, pages.length - 1))];

  // Translate page_number → page id for QueueView's jump-to-canvas action.
  const pageIdByNumber = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of pages) m.set(p.page_number, p.id);
    return m;
  }, [pages]);

  // Derive the pipeline phase from the doc's backend state plus our local
  // "starting" flag. The phase drives the overlay AND the Continue button
  // label / disabled reasoning.
  // Backend stages: 0=ingest 1=detect 2=extract 3=assemble-running 4=done.
  const pipelinePhase: PipelinePhase | null = useMemo(() => {
    if (!doc) return null;
    if (pipelineStarting) return "extracting";
    // Extract running OR extract complete but assemble not yet running
    // (the brief sync pause between extract.onSuccess and assemble.mutate).
    if (doc.current_stage === 2 && doc.stage_status === "running") return "extracting";
    if (doc.current_stage === 2 && doc.stage_status === "complete" && assembleMutation.isPending) return "assembling";
    if (doc.current_stage === 3) return "assembling";
    if (doc.current_stage === 4 && doc.stage_status === "complete") return "complete";
    return null;
  }, [doc?.current_stage, doc?.stage_status, pipelineStarting, assembleMutation.isPending]);

  // Auto-navigate to the dashboard once the pipeline finishes — the user
  // wanted "page changes" as the success signal. We fire it once via a ref
  // so navigating back into Review on a stage-4 doc doesn't immediately
  // bounce them out again.
  const navigatedRef = useRef(false);
  useEffect(() => {
    if (!doc) return;
    if (doc.current_stage === 4 && doc.stage_status === "complete" && pipelineStarting === false) {
      // Only auto-navigate if the user just ran the pipeline this session.
      if (extractMutation.isSuccess || assembleMutation.isSuccess) {
        if (navigatedRef.current) return;
        navigatedRef.current = true;
        showToast("Pipeline complete — back to Dashboard");
        // Small delay so the user sees the green "complete" tick before nav.
        const t = setTimeout(() => navigate("/v2"), 900);
        return () => clearTimeout(t);
      }
    }
  }, [doc?.current_stage, doc?.stage_status, extractMutation.isSuccess, assembleMutation.isSuccess]);

  const objectsForPage: DetectedObject[] = useMemo(() => {
    if (!objectsQuery.data || !activePage) return [];
    const match = objectsQuery.data.pages.find((p) => p.page_id === activePage.id);
    return match?.objects ?? [];
  }, [objectsQuery.data, activePage]);

  const allObjects: DetectedObject[] = useMemo(() => {
    if (!objectsQuery.data) return [];
    return objectsQuery.data.pages.flatMap((p) => p.objects);
  }, [objectsQuery.data]);

  // Per-page review progress for the thumbnail badges. "reviewed" = confirmed
  // OR rejected; once it equals total the badge flips to the green done state.
  const pageProgress = useMemo(() => {
    const map = new Map<string, { total: number; reviewed: number }>();
    if (!objectsQuery.data) return map;
    for (const p of objectsQuery.data.pages) {
      const total = p.objects.length;
      const reviewed = p.objects.filter((o) => o.status === "confirmed" || o.status === "rejected").length;
      map.set(p.page_id, { total, reviewed });
    }
    return map;
  }, [objectsQuery.data]);

  // All selected objects on the current page, for batch actions. Order
  // mirrors page-document order, NOT selection order — that's fine for
  // bulk operations but the "primary" (last-clicked) is computed below
  // from the selection set's insertion order.
  const selectedObjects: DetectedObject[] = useMemo(() => {
    if (selectedIds.size === 0) return [];
    return objectsForPage.filter((o) => selectedIds.has(o.id));
  }, [selectedIds, objectsForPage]);

  // Primary = last-added id in the selection set (Set preserves insertion
  // order). The inspector reads this so it tracks the most recent click,
  // matching the Konva Transformer attachment in PageStage.
  const selectedObject: DetectedObject | null = useMemo(() => {
    if (selectedIds.size === 0) return null;
    const lastId = Array.from(selectedIds).at(-1);
    if (!lastId) return null;
    return objectsForPage.find((o) => o.id === lastId) ?? null;
  }, [selectedIds, objectsForPage]);

  const totalPages = pages.length;
  useKeyboardShortcuts(Boolean(doc), {
    onApprove: () => {
      const targets = selectedObjects.filter((o) => o.status !== "confirmed").map((o) => o.id);
      if (targets.length === 0) return;
      if (targets.length === 1) edits.approve.mutate(targets[0]);
      else edits.approveMany.mutate(targets);
    },
    onReject: () => {
      const targets = selectedObjects.filter((o) => o.status !== "rejected").map((o) => o.id);
      if (targets.length === 0) return;
      if (targets.length === 1) edits.reject.mutate(targets[0]);
      else edits.rejectMany.mutate(targets);
    },
    onNextPage: () => { if (totalPages > 0) setCurrentPageIndex(Math.min(currentPageIndex + 1, totalPages - 1)); },
    onPrevPage: () => { if (totalPages > 0) setCurrentPageIndex(Math.max(currentPageIndex - 1, 0)); },
    onUndo: () => edits.undo.mutate(),
    onRedo: () => edits.redo.mutate(),
    onDelete: () => { if (selectedObject) edits.del.mutate(selectedObject.id); },
    onToggleDraw: () => {
      const next = mode === "draw" ? "select" : "draw";
      setMode(next);
      if (next === "draw") deselectAll();
      showToast(next === "draw" ? "Draw mode — drag on the page to add a region" : "Select mode");
    },
    onEscape: () => {
      if (mode === "draw") { setMode("select"); showToast("Select mode"); return; }
      if (viewMode === "diff" || viewMode === "queue") setViewMode("review");
      else deselectAll();
    },
    onZoomIn: () => zoomIn(),
    onZoomOut: () => zoomOut(),
    onZoomReset: () => resetZoom(),
  });

  if (docQuery.isLoading) {
    return (
      <div className={styles.app}>
        <div className={styles.loading}>LOADING DOCUMENT…</div>
      </div>
    );
  }

  if (docQuery.error || !doc) {
    return (
      <div className={styles.app}>
        <div className={styles.errorState}>
          <h3>Document not found</h3>
          <p>
            {docQuery.error instanceof Error
              ? docQuery.error.message
              : "The document could not be loaded."}
          </p>
          <Button variant="primary" onClick={() => navigate("/v2")}>Back to Dashboard</Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.app} data-view={viewMode}>
      {/* TOP */}
      <div className={styles.top}>
        <div className={styles.brand}>
          <span className={styles.dot} />
          PDFer
        </div>
        <div className={styles.fileTitle}>
          {doc.filename}
          {activePage && (
            <span className={styles.pg}>
              PAGE {activePage.page_number} / {pages.length}
            </span>
          )}
        </div>
        <div className={styles.topActions}>
          <StagePill current_stage={doc.current_stage} stage_status={doc.stage_status} />
          <Button
            variant={mode === "draw" ? "primary" : "ghost"}
            onClick={() => {
              const next = mode === "draw" ? "select" : "draw";
              setMode(next);
              if (next === "draw") deselectAll();
              showToast(next === "draw" ? "Draw mode — drag on the page to add a region" : "Select mode");
            }}
            title="Toggle draw mode (D) — drag on the page to add a missing region"
          >
            {mode === "draw" ? "✎ Drawing…" : "✎ Draw"}
          </Button>
          <div className={styles.zoomCluster} role="group" aria-label="Zoom">
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={zoomOut}
              title="Zoom out (Ctrl/⌘ −)"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className={styles.zoomReadout}
              onClick={resetZoom}
              title="Reset to fit (Ctrl/⌘ 0)"
              aria-label={`Zoom ${Math.round(userZoom * 100)} percent — click to fit`}
            >
              {Math.round(userZoom * 100)}%
            </button>
            <button
              type="button"
              className={styles.zoomBtn}
              onClick={zoomIn}
              title="Zoom in (Ctrl/⌘ +)"
              aria-label="Zoom in"
            >
              +
            </button>
          </div>
          {viewMode === "diff" && (
            <Button
              variant="ghost"
              onClick={() => setViewMode("review")}
              title="Exit Diff View (Esc)"
            >
              ✕ Exit Diff
            </Button>
          )}
          {/* Queue / Canvas toggle. Available whenever objects exist (stage >= 1). */}
          {doc.current_stage >= 1 && viewMode !== "diff" && (
            <Button
              variant={viewMode === "queue" ? "primary" : "default"}
              onClick={() => setViewMode(viewMode === "queue" ? "review" : "queue")}
              title={viewMode === "queue" ? "Switch back to canvas view (Esc)" : "Switch to list view of every region"}
            >
              {viewMode === "queue" ? "◧ Canvas" : "≡ Queue"}
            </Button>
          )}
          {doc.current_stage >= 1 && doc.current_stage < 2 && (
            <Button
              variant="default"
              icon={<span className={styles.btnGlyph}>◐</span>}
              onClick={() => describeMutation.mutate()}
              disabled={describeMutation.isPending}
              title="Run Gemma on every region so the reviewer sees the AI read inline"
            >
              {describeMutation.isPending ? "Running Gemma…" : "Run Gemma"}
            </Button>
          )}
          {/* Tuples corpus pill — visible once any tuples have accumulated.
              Click downloads the JSONL when the corpus is ready (≥200). */}
          {trainingStatsQuery.data && trainingStatsQuery.data.total > 0 && (
            <a
              href={trainingExportUrl()}
              download
              className={styles.tuplesPill}
              data-ready={trainingStatsQuery.data.ready_for_training ? "true" : "false"}
              title={
                trainingStatsQuery.data.ready_for_training
                  ? "Training corpus ready (≥200 tuples). Click to download JSONL."
                  : `${trainingStatsQuery.data.total} tuples — need 200 for LoRA Phase 2.`
              }
            >
              {trainingStatsQuery.data.total} tuples
              {trainingStatsQuery.data.ready_for_training && " ✓"}
            </a>
          )}
          {/* Download Bundle — only after assemble has produced output. */}
          {doc.current_stage >= 4 && doc.stage_status === "complete" && (
            <a
              href={bundleUrl(doc.id)}
              download
              className={styles.bundleBtn}
              title="Download the assembled bundle: document.md + assets/ + metadata.json"
            >
              ↓ Download Bundle
            </a>
          )}
          <Link to="/v2" style={{ textDecoration: "none" }}>
            <Button variant="ghost">← Dashboard</Button>
          </Link>
        </div>
      </div>

      {/* LEFT RAIL — hidden in Diff View to widen the canvas */}
      {viewMode === "review" && (
        <div className={styles.rail}>
          <StageRail
            current_stage={doc.current_stage}
            stage_status={doc.stage_status}
            review={reviewStatsQuery.data}
          />
          <div style={{ height: 36 }} />
          <PageThumbs
            pages={pages}
            activeIndex={currentPageIndex}
            onSelect={setCurrentPageIndex}
            progress={pageProgress}
          />
        </div>
      )}

      {/* CENTER STAGE — PdfStage in Review, DiffView in Diff */}
      <div className={styles.stage}>
        <AnimatePresence mode="wait">
          <motion.div
            key={(activePage?.id ?? "empty") + ":" + viewMode}
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.985 }}
            transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
            style={{ width: "100%", height: "100%" }}
          >
            {viewMode === "queue" ? (
              <QueueView
                docId={doc.id}
                pageIdByNumber={pageIdByNumber}
                onJumpToObject={(pageId, objectId) => {
                  // Jump to the page containing the row, select the object,
                  // and return to canvas — exactly the legacy "G" shortcut flow.
                  const idx = pages.findIndex((p) => p.id === pageId);
                  if (idx >= 0) setCurrentPageIndex(idx);
                  setViewMode("review");
                  // Defer the selection until after the view swap so the
                  // overlay / Konva picks up the new page first.
                  setTimeout(() => useReviewStore.getState().selectObject(objectId), 50);
                }}
              />
            ) : viewMode === "diff" ? (
              <DiffView
                docId={doc.id}
                page={activePage}
                objects={objectsForPage}
                onBboxChange={(objectId, kind, bbox) => {
                  if (kind === "move") edits.move.mutate({ objectId, bbox });
                  else edits.resize.mutate({ objectId, bbox });
                }}
                onCreate={(pageId, bbox) => {
                  edits.create.mutate({ pageId, bbox });
                  setMode("select");
                }}
              />
            ) : (
              <PdfStage
                docId={doc.id}
                page={activePage}
                objects={objectsForPage}
                onBboxChange={(objectId, kind, bbox) => {
                  if (kind === "move") edits.move.mutate({ objectId, bbox });
                  else edits.resize.mutate({ objectId, bbox });
                }}
                onCreate={(pageId, bbox) => {
                  edits.create.mutate({ pageId, bbox });
                  // Drop back into select mode after a successful draw — the
                  // most common next action is approve/relabel the new region,
                  // and staying in draw mode would block clicking it.
                  setMode("select");
                }}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* BOTTOM */}
      <div className={styles.bottom}>
        {(() => {
          const stats = reviewStatsQuery.data;
          const reviewReady =
            doc.current_stage >= 1 &&
            doc.stage_status === "complete" &&
            stats != null &&
            stats.total_objects > 0;
          const reviewDone = stats != null && stats.unreviewed === 0;

          // Stage-aware Continue button. The doc's current stage drives both
          // the label and what clicking does:
          //   stage 1 complete + all reviewed  → "Continue → Assemble" (chains extract+assemble)
          //   stage 2 complete (extracted)     → "Run Assembly"  (assemble only)
          //   stage 3 / 4 (assembling/done)    → handled by overlay; bar shows disabled "Pipeline running"
          let continueLabel = "Continue → Assemble";
          let continueTitle = "Run extraction + assembly and head to Dashboard";
          let continueDisabled = false;
          let blockedReason: string | undefined;
          let onContinueClick: () => void = () => {
            extractMutation.mutate();
          };
          const continueBusy =
            extractMutation.isPending || assembleMutation.isPending || pipelineStarting ||
            (doc.current_stage === 2 && doc.stage_status === "running") ||
            (doc.current_stage === 3 && doc.stage_status === "running");

          if (doc.current_stage >= 4 && doc.stage_status === "complete") {
            continueLabel = "View in Dashboard";
            continueTitle = "Pipeline complete — back to the Dashboard";
            onContinueClick = () => navigate("/v2");
          } else if (doc.current_stage === 2 && doc.stage_status === "complete") {
            continueLabel = "Run Assembly";
            continueTitle = "Build the markdown bundle from the extracted regions";
            onContinueClick = () => assembleMutation.mutate();
          } else if (!reviewReady) {
            continueDisabled = true;
            blockedReason = "Detection isn't finished yet — wait for the Detect stage to complete.";
          } else if (!reviewDone) {
            continueDisabled = true;
            const remaining = stats!.unreviewed;
            blockedReason = `${remaining} ${remaining === 1 ? "region" : "regions"} still need to be approved or rejected.`;
          }

          return (
            <ReviewActionBar
              docId={doc.id}
              selected={selectedObject}
              selectedAll={selectedObjects}
              stats={stats}
              continueLabel={continueBusy ? "Running…" : continueLabel}
              continueTitle={continueTitle}
              continueDisabled={continueDisabled}
              continueBusy={continueBusy}
              onContinue={onContinueClick}
              onShowToast={showToast}
              blockedReason={blockedReason}
            />
          );
        })()}
      </div>

      {/* RIGHT RAIL — upper stack scrolls behind pinned Original thumb */}
      <div className={styles.insp}>
        <div className={styles.inspScroll}>
          <ObjectInspector
            selected={selectedObject}
            multiCount={selectedObjects.length}
            multiObjects={selectedObjects}
            onRelabel={(objectId, label) => edits.relabel.mutate({ objectId, label })}
            relabelPending={edits.relabel.isPending}
          />
          <AIReadPanel selected={selectedObject} />
          <AutoConfirmPanel
            objects={allObjects}
            disabled={!doc || doc.current_stage < 1}
            isPending={edits.autoConfirm.isPending}
            onRun={(threshold) => edits.autoConfirm.mutate(threshold)}
          />
        </div>
        {viewMode === "review" && (
          <div className={styles.inspPinned}>
            <OriginalThumb docId={doc.id} page={activePage} />
          </div>
        )}
      </div>

      <ToastHost docId={doc.id} />

      <AnimatePresence>
        {pipelinePhase && pipelinePhase !== "complete" && (
          <PipelineProgress
            key="pipeline-progress"
            phase={pipelinePhase}
            extracted={extractedCount}
            total={reviewStatsQuery.data?.total_objects}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function StagePill({ current_stage, stage_status }: { current_stage: number; stage_status: string }) {
  if (stage_status === "running") return <StatusPill tone="running" dot pulsing>PROCESSING</StatusPill>;
  if (stage_status === "failed") return <StatusPill tone="error" dot>FAILED</StatusPill>;
  if (current_stage >= 4) return <StatusPill tone="done" dot>EXPORTED</StatusPill>;
  if (current_stage >= 1) return <StatusPill tone="ready" dot>READY</StatusPill>;
  return <StatusPill tone="pending">PENDING</StatusPill>;
}
