import styles from "./StatusPill.module.css";

export type PillTone = "pending" | "ready" | "running" | "done" | "error";

interface StatusPillProps {
  tone?: PillTone;
  dot?: boolean;
  pulsing?: boolean;
  children: React.ReactNode;
}

export function StatusPill({ tone = "pending", dot, pulsing, children }: StatusPillProps) {
  return (
    <span className={`${styles.pill} ${styles[tone]}`}>
      {dot && <span className={`${styles.dot} ${pulsing ? styles.pulsing : ""}`} />}
      {children}
    </span>
  );
}
