import styles from "./StageNode.module.css";

export type StageState = "past" | "current" | "future";

interface StageNodeProps {
  label: string;
  state: StageState;
}

export function StageNode({ label, state }: StageNodeProps) {
  const stateClass = state === "past" ? styles.past : state === "current" ? styles.current : "";
  return (
    <div className={`${styles.stage} ${stateClass}`}>
      <div className={styles.node} />
      <div className={styles.label}>{label}</div>
    </div>
  );
}
