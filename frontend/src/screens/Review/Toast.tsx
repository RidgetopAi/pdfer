import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useReviewStore } from "../../store/reviewStore";
import { useObjectEdits } from "../../hooks/useObjectEdits";
import styles from "./Toast.module.css";

interface ToastHostProps {
  docId: string | undefined;
  /** Auto-dismiss timeout, default 4s. */
  ttl?: number;
}

export function ToastHost({ docId, ttl = 4000 }: ToastHostProps) {
  const toast = useReviewStore((s) => s.toast);
  const clearToast = useReviewStore((s) => s.clearToast);
  const { undo, redo } = useObjectEdits(docId);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => clearToast(), ttl);
    return () => clearTimeout(t);
  }, [toast, ttl, clearToast]);

  return (
    <div className={styles.host}>
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.timestamp}
            className={styles.toast}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <span>{toast.message}</span>
            {toast.action === "undo" && (
              <button
                className={styles.action}
                onClick={() => {
                  undo.mutate();
                  clearToast();
                }}
              >
                UNDO
              </button>
            )}
            {toast.action === "redo" && (
              <button
                className={styles.action}
                onClick={() => {
                  redo.mutate();
                  clearToast();
                }}
              >
                REDO
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
