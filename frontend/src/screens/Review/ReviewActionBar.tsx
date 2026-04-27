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
  selected: DetectedObject | null;
  stats?: ReviewStats;
  onContinue?: () => void;
  canContinue: boolean;
}

export function ReviewActionBar({ docId, selected, stats, onContinue, canContinue }: ReviewActionBarProps) {
  const qc = useQueryClient();
  const showToast = useReviewStore((s) => s.showToast);
  const { approve, reject, undo, redo } = useObjectEdits(docId);

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

  const hasSel = selected != null;
  const busy = approve.isPending || reject.isPending;
  const alreadyApproved = selected?.status === "confirmed";
  const alreadyRejected = selected?.status === "rejected";

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <div className={styles.selLabel}>
          {hasSel ? (
            <>SELECTED · <strong>{selected!.label.replace(/_/g, " ")}</strong></>
          ) : (
            "NO SELECTION"
          )}
        </div>
        <Button
          variant="approve"
          icon={<Check size={14} />}
          disabled={!hasSel || alreadyApproved || busy}
          onClick={() => selected && approve.mutate(selected.id)}
          title="Approve (A)"
        >
          Approve
        </Button>
        <Button
          variant="reject"
          icon={<X size={14} />}
          disabled={!hasSel || alreadyRejected || busy}
          onClick={() => selected && reject.mutate(selected.id)}
          title="Reject (R)"
        >
          Reject
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
