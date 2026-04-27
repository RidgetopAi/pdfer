import { motion, AnimatePresence } from "framer-motion";
import { Panel, StatusPill } from "../../design";
import type { DetectedObject } from "../../api/client";
import styles from "./AIReadPanel.module.css";

interface AIReadPanelProps {
  selected: DetectedObject | null;
}

/**
 * AI Read — collapsed by default, expands with a height animation once
 * a description is present. Header is always visible and shows the
 * current status so the user knows where they stand.
 */
export function AIReadPanel({ selected }: AIReadPanelProps) {
  const status = selected?.description_status ?? "pending";
  const hasText = Boolean(selected?.description?.trim());

  const { tone, label, pulsing } = mapStatus(status, hasText);
  const expanded = Boolean(selected) && (hasText || status === "failed");

  return (
    <Panel
      title="AI Read"
      quiet={!expanded}
      trailing={<StatusPill tone={tone} dot={tone !== "pending"} pulsing={pulsing}>{label}</StatusPill>}
    >
      <AnimatePresence initial={false}>
        {expanded && selected && (
          <motion.div
            key={selected.id + status}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] },
              opacity: { duration: 0.22, delay: 0.06 },
            }}
            className={styles.wrap}
          >
            {status === "failed" ? (
              <p className={styles.failed}>Description failed. Try Re-describe to retry.</p>
            ) : hasText ? (
              <>
                <div className={styles.text}>{selected.description}</div>
                {selected.description_model && (
                  <div className={styles.meta}>
                    <span>{selected.description_model}</span>
                    {selected.description_edited_by_user ? <span>· EDITED</span> : null}
                  </div>
                )}
              </>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
      {!expanded && selected && (
        <div className={styles.emptyHint}>
          {status === "skipped"
            ? "Skipped — this region type doesn't receive AI read."
            : "Run Gemma to generate a description for this region."}
        </div>
      )}
      {!selected && (
        <div className={styles.emptyHint}>Select a region to see its AI read.</div>
      )}
    </Panel>
  );
}

import type { PillTone } from "../../design";

function mapStatus(
  status: string,
  hasText: boolean,
): { tone: PillTone; label: string; pulsing: boolean } {
  if (status === "described" && hasText) return { tone: "ready", label: "READY", pulsing: false };
  if (status === "failed") return { tone: "error", label: "FAILED", pulsing: false };
  if (status === "skipped") return { tone: "pending", label: "SKIPPED", pulsing: false };
  return { tone: "pending", label: "PENDING", pulsing: false };
}
