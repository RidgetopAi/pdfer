import type { ReactNode } from "react";
import styles from "./GlowWrap.module.css";

interface GlowWrapProps {
  children: ReactNode;
  backlit?: boolean;      // ambient soft halo drop-shadow
  breathing?: boolean;    // pulsing box-shadow ring
  shimmer?: boolean;      // diagonal scan sweep overlay
  className?: string;
}

/**
 * Composable effect wrapper for the electric backlit look.
 * Use on selected regions, active panels, hero elements.
 */
export function GlowWrap({ children, backlit, breathing, shimmer, className }: GlowWrapProps) {
  const cls = [
    styles.wrap,
    backlit ? styles.backlit : "",
    breathing ? styles.breathing : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      {children}
      {shimmer && <div className={styles.shimmer} />}
    </div>
  );
}
