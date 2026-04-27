import type { ReactNode } from "react";
import styles from "./Panel.module.css";

interface PanelProps {
  title?: string;
  trailing?: ReactNode;   // rendered in the head (status pill, action)
  quiet?: boolean;         // collapsed / background variant
  children?: ReactNode;
  className?: string;
}

export function Panel({ title, trailing, quiet, children, className }: PanelProps) {
  const cls = [styles.panel, quiet ? styles.quiet : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      {(title || trailing) && (
        <div className={styles.head}>
          {title && <div className={styles.title}>{title}</div>}
          {trailing}
        </div>
      )}
      {children && <div className={styles.body}>{children}</div>}
    </div>
  );
}
