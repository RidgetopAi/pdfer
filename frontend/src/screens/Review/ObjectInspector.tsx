import { motion } from "framer-motion";
import { Panel, StatusPill, Button } from "../../design";
import type { DetectedObject } from "../../api/client";
import { colorForLabel, kindForLabel } from "./regionColors";
import styles from "./ObjectInspector.module.css";

interface ObjectInspectorProps {
  selected: DetectedObject | null;
  onRedetect?: (obj: DetectedObject) => void;
}

export function ObjectInspector({ selected, onRedetect }: ObjectInspectorProps) {
  const title = "Object Inspector";

  if (!selected) {
    return (
      <Panel title={title} trailing={<StatusPill tone="pending">NO SELECTION</StatusPill>}>
        <div className={styles.empty}>
          Click a region on the page to inspect its type, confidence, and details.
        </div>
      </Panel>
    );
  }

  const kind = kindForLabel(selected.label);
  const color = colorForLabel(selected.label);
  const width = Math.abs(selected.bbox_x2 - selected.bbox_x1);
  const height = Math.abs(selected.bbox_y2 - selected.bbox_y1);
  const conf = selected.confidence ?? null;
  const statusTone =
    selected.status === "confirmed" ? "done"
    : selected.status === "rejected" ? "error"
    : "pending";
  const statusLabel =
    selected.status === "confirmed" ? "APPROVED"
    : selected.status === "rejected" ? "REJECTED"
    : "PENDING";

  return (
    <Panel
      title={title}
      trailing={<StatusPill tone={statusTone} dot>{statusLabel}</StatusPill>}
    >
      <motion.div
        key={selected.id}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <div className={styles.kv}>
          <div className={styles.key}>TYPE</div>
          <div className={styles.val}>
            <span className={styles.tintDot} style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
            {kind.charAt(0).toUpperCase() + kind.slice(1)} · {selected.label.replace(/_/g, " ")}
          </div>

          <div className={styles.key}>REGION</div>
          <div className={`${styles.val} ${styles.monoVal}`}>
            {Math.round(width)} × {Math.round(height)} px
          </div>

          {conf != null && (
            <>
              <div className={styles.key}>CONFIDENCE</div>
              <div className={styles.val}>
                {(conf * 100).toFixed(0)}%
                <div className={styles.confidence}>
                  <div className={styles.confFill} style={{ width: `${conf * 100}%` }} />
                </div>
              </div>
            </>
          )}

          {selected.reading_order != null && (
            <>
              <div className={styles.key}>ORDER</div>
              <div className={styles.val}>{selected.reading_order}</div>
            </>
          )}

          <div className={styles.key}>SOURCE</div>
          <div className={`${styles.val} ${styles.sourceVal}`}>{selected.source}</div>
        </div>

        <div className={styles.actions}>
          {onRedetect && (
            <Button size="mini" onClick={() => onRedetect(selected)}>Re-detect</Button>
          )}
        </div>
      </motion.div>
    </Panel>
  );
}
