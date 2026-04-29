import { motion } from "framer-motion";
import { Panel, StatusPill, Button } from "../../design";
import type { DetectedObject } from "../../api/client";
import { ALL_LABELS, colorForLabel, kindForLabel } from "./regionColors";
import styles from "./ObjectInspector.module.css";

interface ObjectInspectorProps {
  selected: DetectedObject | null;
  // Full multi-selection. When length > 1 we render a summary panel
  // (counts by status) instead of single-object detail.
  multiCount?: number;
  multiObjects?: DetectedObject[];
  onRelabel?: (objectId: string, label: string) => void;
  relabelPending?: boolean;
  onRedetect?: (obj: DetectedObject) => void;
}

export function ObjectInspector({ selected, multiCount = 0, multiObjects = [], onRelabel, relabelPending, onRedetect }: ObjectInspectorProps) {
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

  if (multiCount > 1) {
    const pending = multiObjects.filter((o) => o.status === "unreviewed").length;
    const approved = multiObjects.filter((o) => o.status === "confirmed").length;
    const rejected = multiObjects.filter((o) => o.status === "rejected").length;
    return (
      <Panel title={title} trailing={<StatusPill tone="pending" dot>{multiCount} SELECTED</StatusPill>}>
        <div className={styles.kv}>
          <div className={styles.key}>SELECTION</div>
          <div className={styles.val}>
            <strong>{multiCount}</strong> regions
          </div>
          <div className={styles.key}>PENDING</div>
          <div className={`${styles.val} ${styles.monoVal}`}>{pending}</div>
          <div className={styles.key}>APPROVED</div>
          <div className={`${styles.val} ${styles.monoVal}`}>{approved}</div>
          <div className={styles.key}>REJECTED</div>
          <div className={`${styles.val} ${styles.monoVal}`}>{rejected}</div>
        </div>
        <div className={styles.empty} style={{ marginTop: 14 }}>
          Use Approve / Reject below or press A / R to act on the whole selection.
          Shift-click a region to add or remove it.
        </div>
      </Panel>
    );
  }

  const kind = kindForLabel(selected.label);
  const color = colorForLabel(selected.label);
  const width = Math.abs(selected.bbox_x2 - selected.bbox_x1);
  const height = Math.abs(selected.bbox_y2 - selected.bbox_y1);
  const conf = selected.confidence ?? null;
  const reliability = selected.review_reliability ?? null;
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
            {onRelabel ? (
              <select
                className={styles.typeSelect}
                value={selected.label}
                disabled={relabelPending}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next !== selected.label) onRelabel(selected.id, next);
                }}
                title="Change region type"
              >
                {ALL_LABELS.map((lbl) => (
                  <option key={lbl} value={lbl}>
                    {lbl.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            ) : (
              <>
                {kind.charAt(0).toUpperCase() + kind.slice(1)} · {selected.label.replace(/_/g, " ")}
              </>
            )}
          </div>

          <div className={styles.key}>REGION</div>
          <div className={`${styles.val} ${styles.monoVal}`}>
            {Math.round(width)} × {Math.round(height)} px
          </div>

          {(reliability ?? conf) != null && (
            <>
              <div className={styles.key}>RELIABILITY</div>
              <div className={styles.val}>
                {((reliability ?? conf ?? 0) * 100).toFixed(0)}%
                <div className={styles.confidence}>
                  <div className={styles.confFill} style={{ width: `${(reliability ?? conf ?? 0) * 100}%` }} />
                </div>
                {conf != null && reliability != null && (
                  <div className={styles.subtle}>YOLO {Math.round(conf * 100)}%</div>
                )}
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
