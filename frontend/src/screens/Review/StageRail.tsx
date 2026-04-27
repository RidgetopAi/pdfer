import { Link } from "react-router-dom";
import { StageNode } from "../../design";
import type { StageState } from "../../design";
import { mapDocumentToCells } from "../Dashboard/stageMapping";
import { STAGE_LABELS } from "../Dashboard/stageMapping";
import styles from "./StageRail.module.css";

interface StageRailProps {
  current_stage: number;
  stage_status: string;
  review?: { pages_complete: number; pages_total: number };
}

/**
 * Vertical stage constellation for the Review screen. Reuses the same
 * stage-mapping logic as the dashboard so state stays consistent — a
 * cell at level 4 in the matrix is a "past" node in the rail, the
 * single current cell becomes the current node, everything else future.
 */
export function StageRail({ current_stage, stage_status, review }: StageRailProps) {
  const cells = mapDocumentToCells({ current_stage, stage_status, review });

  const states: StageState[] = cells.map((c) => {
    if (c.current) return "current";
    if (c.level >= 4) return "past";
    return "future";
  });

  return (
    <div className={styles.rail}>
      <div className={styles.header}>
        <Link to="/v2" className={styles.back}>← DASHBOARD</Link>
      </div>
      <div className={styles.stages}>
        {STAGE_LABELS.map((label, i) => (
          <StageNode key={label} label={label} state={states[i]} />
        ))}
      </div>
    </div>
  );
}
