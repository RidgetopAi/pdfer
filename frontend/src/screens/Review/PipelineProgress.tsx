import { motion } from "framer-motion";
import styles from "./PipelineProgress.module.css";

export type PipelinePhase = "extracting" | "assembling" | "complete";

interface PipelineProgressProps {
  phase: PipelinePhase;
  // Per-region extract progress. Computed from object.extracted WS events
  // by Review.tsx; if unknown we fall back to a indeterminate breathing ring.
  extracted?: number;
  total?: number;
  // Optional copy override — Review.tsx sets a tail string while we're
  // briefly between extract done and assemble starting.
  detail?: string;
}

/**
 * Full-screen-but-translucent overlay that mounts whenever the Review →
 * Assemble pipeline is running on the backend. Stays up until stage 4
 * complete (the parent unmounts it). Renders a centered card with a
 * breathing ring + live counter.
 *
 * Designed to read as "calm, working" — not a modal, not an alert.
 * pointer-events: none on the layer so accidental clicks fall through
 * to the dimmed Review surface; only the card itself is interactive
 * (it has no actions yet, but Cancel could land here later).
 */
export function PipelineProgress({ phase, extracted, total, detail }: PipelineProgressProps) {
  const heading =
    phase === "extracting" ? "Extracting regions"
    : phase === "assembling" ? "Assembling markdown"
    : "Pipeline complete";

  const ratio =
    typeof extracted === "number" && typeof total === "number" && total > 0
      ? Math.min(1, extracted / total)
      : null;

  return (
    <motion.div
      className={styles.layer}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <motion.div
        className={styles.card}
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.99 }}
        transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <ProgressRing ratio={ratio} indeterminate={ratio == null} />
        <div className={styles.heading}>{heading}</div>
        <div className={styles.detail}>
          {phase === "extracting" && total
            ? `${extracted ?? 0} / ${total} regions`
            : phase === "extracting"
            ? "Starting…"
            : phase === "assembling"
            ? (detail ?? "Building markdown + assets")
            : "Done"}
        </div>
      </motion.div>
    </motion.div>
  );
}

function ProgressRing({ ratio, indeterminate }: { ratio: number | null; indeterminate: boolean }) {
  const r = 28;
  const c = 2 * Math.PI * r;
  const offset = ratio == null ? c * 0.75 : c * (1 - ratio);
  return (
    <svg
      className={`${styles.ring} ${indeterminate ? styles.ringSpin : ""}`}
      viewBox="0 0 64 64"
      width="64"
      height="64"
      aria-hidden="true"
    >
      <circle className={styles.ringTrack} cx="32" cy="32" r={r} />
      <circle
        className={styles.ringFill}
        cx="32"
        cy="32"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 32 32)"
      />
    </svg>
  );
}
