import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Check, X, ArrowRight, Undo2, Redo2 } from "lucide-react";
import { Button } from "../../design";
import {
  extractDocument,
  fetchUndoState,
  type DetectedObject,
  type ReviewStats,
} from "../../api/client";
import { useReviewStore } from "../../store/reviewStore";
import { useObjectEdits } from "../../hooks/useObjectEdits";
import styles from "./ReviewActionBar.module.css";

interface ReviewActionBarProps {
  docId: string;
  // Primary selection (for the inspector-adjacent label preview).
  selected: DetectedObject | null;
  // Full selection set on the active page — drives batch approve/reject and
  // the count badges. Empty when nothing selected.
  selectedAll: DetectedObject[];
  stats?: ReviewStats;
  onContinue?: () => void;
  canContinue: boolean;
}

export function ReviewActionBar({ docId, selected, selectedAll, stats, onContinue, canContinue }: ReviewActionBarProps) {
  const qc = useQueryClient();
  const showToast = useReviewStore((s) => s.showToast);
  const { approve, approveMany, reject, rejectMany, undo, redo } = useObjectEdits(docId);

  const undoState = useQuery({
    queryKey: ["undoState", docId],
    queryFn: () => fetchUndoState(docId),
    staleTime: 5_000,
  });

  const extractMutation = useMutation({
    mutationFn: () => extractDocument(docId, true),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["document", docId] });
      qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
      qc.invalidateQueries({ queryKey: ["documents"] });
      showToast("Extraction started");
      onContinue?.();
    },
    onError: (e) => showToast(`Could not start extraction: ${(e as Error).message}`),
  });

  const count = selectedAll.length;
  const hasSel = count > 0;
  const isMulti = count > 1;
  const busy = approve.isPending || reject.isPending || approveMany.isPending || rejectMany.isPending;

  // For multi: enable approve if any aren't already confirmed; same for reject.
  // For single: fall back to the primary's current state.
  const approvableIds = selectedAll.filter((o) => o.status !== "confirmed").map((o) => o.id);
  const rejectableIds = selectedAll.filter((o) => o.status !== "rejected").map((o) => o.id);
  const canApprove = approvableIds.length > 0;
  const canReject = rejectableIds.length > 0;

  function doApprove() {
    if (approvableIds.length === 0) return;
    if (approvableIds.length === 1) approve.mutate(approvableIds[0]);
    else approveMany.mutate(approvableIds);
  }
  function doReject() {
    if (rejectableIds.length === 0) return;
    if (rejectableIds.length === 1) reject.mutate(rejectableIds[0]);
    else rejectMany.mutate(rejectableIds);
  }

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <div className={styles.selLabel}>
          {!hasSel ? (
            "NO SELECTION"
          ) : isMulti ? (
            <>SELECTED · <strong>{count} regions</strong></>
          ) : (
            <>SELECTED · <strong>{selected!.label.replace(/_/g, " ")}</strong></>
          )}
        </div>
        <Button
          variant="approve"
          icon={<Check size={14} />}
          disabled={!canApprove || busy}
          onClick={doApprove}
          title={isMulti ? `Approve ${approvableIds.length} (A)` : "Approve (A)"}
        >
          {isMulti && approvableIds.length > 1 ? `Approve (${approvableIds.length})` : "Approve"}
        </Button>
        <Button
          variant="reject"
          icon={<X size={14} />}
          disabled={!canReject || busy}
          onClick={doReject}
          title={isMulti ? `Reject ${rejectableIds.length} (R)` : "Reject (R)"}
        >
          {isMulti && rejectableIds.length > 1 ? `Reject (${rejectableIds.length})` : "Reject"}
        </Button>
        <Button
          variant="ghost"
          icon={<Undo2 size={14} />}
          disabled={!undoState.data?.can_undo || undo.isPending}
          onClick={() => undo.mutate()}
          title={undoState.data?.undo_description ? `Undo: ${undoState.data.undo_description} (⌘Z)` : "Undo (⌘Z)"}
        >
          Undo
        </Button>
        <Button
          variant="ghost"
          icon={<Redo2 size={14} />}
          disabled={!undoState.data?.can_redo || redo.isPending}
          onClick={() => redo.mutate()}
          title={undoState.data?.redo_description ? `Redo: ${undoState.data.redo_description} (⌘⇧Z)` : "Redo (⌘⇧Z)"}
        >
          Redo
        </Button>
      </div>

      <div className={styles.right}>
        {stats && (
          <div className={styles.summary}>
            <span><b>{stats.confirmed}</b> APPROVED</span>
            <span><b>{stats.rejected}</b> REJECTED</span>
            <span><b>{stats.unreviewed}</b> PENDING</span>
          </div>
        )}
        <Button
          variant="primary"
          icon={<ArrowRight size={14} />}
          disabled={!canContinue || extractMutation.isPending}
          onClick={() => extractMutation.mutate()}
          title={
            !canContinue
              ? "Approve or reject all regions before continuing"
              : "Run extraction and advance to Assemble"
          }
        >
          {extractMutation.isPending ? "Starting…" : "Continue → Assemble"}
        </Button>
      </div>
    </div>
  );
}
