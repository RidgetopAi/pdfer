import type { PageSummary } from "../../api/client";
import { thumbUrl } from "../../api/client";
import styles from "./PageThumbs.module.css";

export interface PageProgress {
  total: number;
  reviewed: number; // approved + rejected
}

interface PageThumbsProps {
  pages: PageSummary[];
  activeIndex: number;
  onSelect: (index: number) => void;
  // Per-page review progress, keyed by page id. Pages missing from the map
  // (or with total === 0) render no badge — nothing to review yet.
  progress?: Map<string, PageProgress>;
}

export function PageThumbs({ pages, activeIndex, onSelect, progress }: PageThumbsProps) {
  if (pages.length === 0) return null;
  return (
    <div className={styles.block}>
      <div className={styles.title}>PAGES · {pages.length}</div>
      <div className={styles.grid}>
        {pages.map((p, i) => {
          const prog = progress?.get(p.id);
          return (
            <button
              key={p.id}
              className={`${styles.thumb} ${i === activeIndex ? styles.active : ""}`}
              onClick={() => onSelect(i)}
              title={progressTitle(p.page_number, prog)}
            >
              {p.thumb_url && <img src={thumbUrl(p.thumb_url)} alt="" />}
              {prog && prog.total > 0 && <ProgressBadge progress={prog} />}
              <span className={styles.n}>
                {String(p.page_number).padStart(2, "0")}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function progressTitle(pageNumber: number, prog: PageProgress | undefined): string {
  if (!prog || prog.total === 0) return `Page ${pageNumber}`;
  if (prog.reviewed >= prog.total) return `Page ${pageNumber} — all ${prog.total} reviewed`;
  return `Page ${pageNumber} — ${prog.reviewed}/${prog.total} reviewed`;
}

// SVG donut. Track is the full ring; fill arc is stroke-dashoffset on a circle
// of circumference = 2πr. We pre-rotate -90° so the arc starts at 12 o'clock.
function ProgressBadge({ progress }: { progress: PageProgress }) {
  const { total, reviewed } = progress;
  const ratio = total === 0 ? 0 : Math.min(1, reviewed / total);
  const done = reviewed >= total;
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const offset = done ? 0 : c * (1 - ratio);
  return (
    <svg
      className={`${styles.badge} ${done ? styles.badgeDone : ""}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle className={styles.badgeTrack} cx="8" cy="8" r={r} />
      <circle
        className={styles.badgeFill}
        cx="8"
        cy="8"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
