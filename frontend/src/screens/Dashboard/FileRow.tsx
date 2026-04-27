import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { StageCell } from "./StageCell";
import { mapDocumentToCells } from "./stageMapping";
import { detectDocument, yoloExportUrl } from "../../api/client";
import type { DocumentSummary, ReviewStats } from "../../api/client";
import styles from "./FileRow.module.css";

interface FileRowProps {
  doc: DocumentSummary;
  review?: ReviewStats;
}

export function FileRow({ doc, review }: FileRowProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cells = mapDocumentToCells({
    current_stage: doc.current_stage,
    stage_status: doc.stage_status,
    review: review ? { pages_complete: review.pages_complete, pages_total: review.pages_total } : undefined,
  });
  const pages = doc.page_count;

  // Auto-detect runs after upload, but old docs and failed detects need a manual
  // escape hatch. Show "Run Detect" when ingest finished but no detect ever
  // ran (stage=0 complete) or when detect previously failed (stage=1 failed).
  const needsDetect =
    (doc.current_stage === 0 && doc.stage_status === "complete") ||
    (doc.current_stage === 1 && doc.stage_status === "failed");

  const detectMutation = useMutation({
    mutationFn: () => detectDocument(doc.id, doc.stage_status === "failed"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["documents"] });
      qc.invalidateQueries({ queryKey: ["reviewStats", doc.id] });
    },
  });

  return (
    <motion.div
      className={styles.row}
      layout
      layoutId={`doc-${doc.id}`}
      transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className={styles.fileSlot}>
        <button
          className={styles.fileButton}
          onClick={() => navigate(`/v2/doc/${doc.id}`)}
        >
          {doc.filename}
        </button>
        {needsDetect && (
          <button
            className={styles.runDetect}
            onClick={(e) => {
              e.stopPropagation();
              detectMutation.mutate();
            }}
            disabled={detectMutation.isPending}
            title={
              doc.stage_status === "failed"
                ? "Previous detect failed — re-run YOLO"
                : "Detect not yet run — run YOLO now"
            }
          >
            {detectMutation.isPending ? "Detecting…" : "Run Detect →"}
          </button>
        )}
        {/* Show export link when there's anything to export. We can't tell
            from DocumentSummary whether reviewed pages exist; show it for
            any doc past detect (current_stage >= 1) and let the backend
            return 409 if the page set is empty. Cheap signal, conservative
            visibility. */}
        {doc.current_stage >= 1 && (
          <a
            className={styles.exportLink}
            href={yoloExportUrl(doc.id)}
            onClick={(e) => e.stopPropagation()}
            download
            title="Download YOLO-format zip of this doc's reviewed pages — feed into a fine-tune"
          >
            ⬇ YOLO
          </a>
        )}
      </div>

      <div className={`${styles.pagePill} ${pages == null ? styles.unknown : ""}`}>
        <span
          style={{
            color: pages == null ? "var(--ink-3)" : "var(--ink-1)",
            textAlign: "left",
            fontSize: pages == null ? 13 : 15,
          }}
        >
          {pages ?? "—"}
        </span>
        <span style={{ color: "var(--ink-3)", textAlign: "right", fontSize: 12, letterSpacing: "0.1em" }}>
          pgs
        </span>
      </div>

      <div className={styles.matrix}>
        {cells.map((state, i) => (
          <StageCell key={i} state={state} />
        ))}
      </div>
    </motion.div>
  );
}
