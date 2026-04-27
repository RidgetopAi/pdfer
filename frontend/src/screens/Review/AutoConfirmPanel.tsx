import { useMemo, useState } from "react";
import { Panel, StatusPill, Button } from "../../design";
import type { DetectedObject } from "../../api/client";
import styles from "./AutoConfirmPanel.module.css";

interface AutoConfirmPanelProps {
  objects: DetectedObject[];
  disabled: boolean;
  onRun: (threshold: number) => void;
  isPending: boolean;
}

/**
 * Bulk-approve control. Shows a threshold slider + a "confirm all above"
 * button; the count hint updates live so the reviewer knows how many
 * regions a click will approve before they click. Always available (no
 * selection required) — the whole point is to clear easy regions in one
 * batch. Backed by a single `auto_confirm` edit which is one undoable
 * batch on the server.
 */
export function AutoConfirmPanel({
  objects,
  disabled,
  onRun,
  isPending,
}: AutoConfirmPanelProps) {
  const [threshold, setThreshold] = useState(0.9);

  const eligibleCount = useMemo(
    () =>
      objects.filter(
        (o) =>
          o.status === "unreviewed" &&
          o.confidence != null &&
          o.confidence >= threshold,
      ).length,
    [objects, threshold],
  );

  const pct = Math.round(threshold * 100);

  return (
    <Panel
      title="Auto-Confirm"
      quiet
      trailing={
        <StatusPill tone={eligibleCount > 0 ? "ready" : "pending"} dot={eligibleCount > 0}>
          {eligibleCount} ELIGIBLE
        </StatusPill>
      }
    >
      <div className={styles.hint}>
        Confirm every unreviewed region at or above the threshold. One batch, one undo.
      </div>
      <div className={styles.sliderRow}>
        <input
          type="range"
          className={styles.slider}
          min={0.5}
          max={1.0}
          step={0.01}
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          aria-label="Confidence threshold"
          disabled={disabled}
        />
        <div className={styles.pct}>{pct}%</div>
      </div>
      <div className={styles.actions}>
        <Button
          variant="approve"
          size="mini"
          onClick={() => onRun(threshold)}
          disabled={disabled || isPending || eligibleCount === 0}
          title={
            eligibleCount === 0
              ? "No unreviewed regions at or above this threshold"
              : `Confirm ${eligibleCount} region${eligibleCount === 1 ? "" : "s"}`
          }
        >
          {isPending
            ? "Confirming…"
            : `Confirm ${eligibleCount} above ${pct}%`}
        </Button>
      </div>
    </Panel>
  );
}
