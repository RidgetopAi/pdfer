import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  submitEdits,
  undoAction,
  redoAction,
  type EditAction,
} from "../api/client";
import { useReviewStore } from "../store/reviewStore";

/**
 * Object edit mutations — approve / reject / undo / redo — wired to the
 * real backend endpoints with toast + flash side effects.
 * Returned mutations can be called from buttons OR from the keyboard
 * shortcut layer, so both surfaces share one source of truth.
 */
export function useObjectEdits(docId: string | undefined) {
  const qc = useQueryClient();
  const showToast = useReviewStore((s) => s.showToast);
  const setFlash = useReviewStore((s) => s.setFlashObjectIds);

  const approve = useMutation({
    mutationFn: (objectId: string) => {
      if (!docId) throw new Error("No document");
      const edits: EditAction[] = [{ action: "confirm", object_id: objectId }];
      return submitEdits(docId, edits);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(batch.description, "undo");
      setFlash(new Set(batch.affected_objects.map((o) => o.id)));
      setTimeout(() => setFlash(new Set()), 600);
    },
    onError: (e) => showToast(`Approve failed: ${(e as Error).message}`),
  });

  const reject = useMutation({
    mutationFn: (objectId: string) => {
      if (!docId) throw new Error("No document");
      const edits: EditAction[] = [{ action: "reject", object_id: objectId }];
      return submitEdits(docId, edits);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(batch.description, "undo");
      setFlash(new Set(batch.affected_objects.map((o) => o.id)));
      setTimeout(() => setFlash(new Set()), 600);
    },
    onError: (e) => showToast(`Reject failed: ${(e as Error).message}`),
  });

  const autoConfirm = useMutation({
    mutationFn: (threshold: number) => {
      if (!docId) throw new Error("No document");
      const edits: EditAction[] = [{ action: "auto_confirm", threshold }];
      return submitEdits(docId, edits);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(batch.description, "undo");
      setFlash(new Set(batch.affected_objects.map((o) => o.id)));
      setTimeout(() => setFlash(new Set()), 600);
    },
    onError: (e) => showToast(`Auto-confirm failed: ${(e as Error).message}`),
  });

  const undo = useMutation({
    mutationFn: () => {
      if (!docId) throw new Error("No document");
      return undoAction(docId);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(`Undid: ${batch.description}`, "redo");
    },
    onError: (e) => showToast(`Undo failed: ${(e as Error).message}`),
  });

  const redo = useMutation({
    mutationFn: () => {
      if (!docId) throw new Error("No document");
      return redoAction(docId);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(`Redid: ${batch.description}`, "undo");
    },
    onError: (e) => showToast(`Redo failed: ${(e as Error).message}`),
  });

  // Bbox edits — move and resize share the backend wire format (action +
  // object_id + bbox coords) but produce different undo descriptions
  // server-side. Both flag the object as extraction_stale.
  const resize = useMutation({
    mutationFn: (args: { objectId: string; bbox: { bbox_x1: number; bbox_y1: number; bbox_x2: number; bbox_y2: number } }) => {
      if (!docId) throw new Error("No document");
      const edits: EditAction[] = [{ action: "resize", object_id: args.objectId, ...args.bbox }];
      return submitEdits(docId, edits);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(batch.description, "undo");
      setFlash(new Set(batch.affected_objects.map((o) => o.id)));
      setTimeout(() => setFlash(new Set()), 600);
    },
    onError: (e) => showToast(`Resize failed: ${(e as Error).message}`),
  });

  const move = useMutation({
    mutationFn: (args: { objectId: string; bbox: { bbox_x1: number; bbox_y1: number; bbox_x2: number; bbox_y2: number } }) => {
      if (!docId) throw new Error("No document");
      const edits: EditAction[] = [{ action: "move", object_id: args.objectId, ...args.bbox }];
      return submitEdits(docId, edits);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(batch.description, "undo");
      setFlash(new Set(batch.affected_objects.map((o) => o.id)));
      setTimeout(() => setFlash(new Set()), 600);
    },
    onError: (e) => showToast(`Move failed: ${(e as Error).message}`),
  });

  // Manual region creation — drawn-from-scratch box. The new object lands
  // with source='manual' and status='unreviewed' (the backend marks both).
  // Manual rows are gold for the YOLO fine-tune corpus: detector missed,
  // human supplied ground truth.
  const create = useMutation({
    mutationFn: (args: {
      pageId: string;
      bbox: { bbox_x1: number; bbox_y1: number; bbox_x2: number; bbox_y2: number };
      label?: string;
    }) => {
      if (!docId) throw new Error("No document");
      const edits: EditAction[] = [
        { action: "create", page_id: args.pageId, label: args.label ?? "paragraph", ...args.bbox },
      ];
      return submitEdits(docId, edits);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(batch.description, "undo");
      setFlash(new Set(batch.affected_objects.map((o) => o.id)));
      setTimeout(() => setFlash(new Set()), 600);
    },
    onError: (e) => showToast(`Create failed: ${(e as Error).message}`),
  });

  const del = useMutation({
    mutationFn: (objectId: string) => {
      if (!docId) throw new Error("No document");
      const edits: EditAction[] = [{ action: "delete", object_id: objectId }];
      return submitEdits(docId, edits);
    },
    onSuccess: (batch) => {
      if (!docId) return;
      qc.invalidateQueries({ queryKey: ["objects", docId] });
      qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
      qc.invalidateQueries({ queryKey: ["undoState", docId] });
      showToast(batch.description, "undo");
    },
    onError: (e) => showToast(`Delete failed: ${(e as Error).message}`),
  });

  return { approve, reject, autoConfirm, undo, redo, resize, move, create, del };
}
