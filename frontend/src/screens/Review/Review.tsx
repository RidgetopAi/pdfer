import { useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  describeDocument,
  fetchDocument,
  fetchObjects,
  fetchReviewStats,
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

  // Live updates — invalidates relevant queries on backend events
  useDocumentEvents(id);

  const edits = useObjectEdits(id);

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

  const objectsForPage: DetectedObject[] = useMemo(() => {
    if (!objectsQuery.data || !activePage) return [];
    const match = objectsQuery.data.pages.find((p) => p.page_id === activePage.id);
    return match?.objects ?? [];
  }, [objectsQuery.data, activePage]);

  const allObjects: DetectedObject[] = useMemo(() => {
    if (!objectsQuery.data) return [];
    return objectsQuery.data.pages.flatMap((p) => p.objects);
  }, [objectsQuery.data]);

  // Selected object for inspector + AI Read — picks the first selected id
  // that exists on the current page (multi-select UI comes later).
  const selectedObject: DetectedObject | null = useMemo(() => {
    if (selectedIds.size === 0) return null;
    for (const obj of objectsForPage) {
      if (selectedIds.has(obj.id)) return obj;
    }
    return null;
  }, [selectedIds, objectsForPage]);

  const totalPages = pages.length;
  useKeyboardShortcuts(Boolean(doc), {
    onApprove: () => { if (selectedObject && selectedObject.status !== "confirmed") edits.approve.mutate(selectedObject.id); },
    onReject:  () => { if (selectedObject && selectedObject.status !== "rejected") edits.reject.mutate(selectedObject.id); },
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
      if (viewMode === "diff") setViewMode("review");
      else deselectAll();
    },
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
          {viewMode === "diff" && (
            <Button
              variant="ghost"
              onClick={() => setViewMode("review")}
              title="Exit Diff View (Esc)"
            >
              ✕ Exit Diff
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
            {viewMode === "diff" ? (
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
        <ReviewActionBar
          docId={doc.id}
          selected={selectedObject}
          stats={reviewStatsQuery.data}
          canContinue={
            doc.current_stage >= 1 &&
            doc.stage_status === "complete" &&
            reviewStatsQuery.data != null &&
            reviewStatsQuery.data.unreviewed === 0 &&
            reviewStatsQuery.data.total_objects > 0
          }
          onContinue={() => {
            // After extraction kicks off the backend will broadcast stage.completed.
            // Nothing to do here yet — stage transition polish comes in Phase 11.
          }}
        />
      </div>

      {/* RIGHT RAIL — upper stack scrolls behind pinned Original thumb */}
      <div className={styles.insp}>
        <div className={styles.inspScroll}>
          <ObjectInspector selected={selectedObject} />
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
