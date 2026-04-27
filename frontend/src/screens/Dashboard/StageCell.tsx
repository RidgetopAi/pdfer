import styles from "./StageCell.module.css";
import type { CellState } from "./stageMapping";

interface StageCellProps {
  state: CellState;
}

export function StageCell({ state }: StageCellProps) {
  const classes = [
    styles.cell,
    state.current ? styles.current : "",
    state.failed ? styles.failed : "",
  ]
    .filter(Boolean)
    .join(" ");
  return <div className={classes} data-level={state.level} />;
}
