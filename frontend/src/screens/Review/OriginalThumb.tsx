import { pageImageUrl } from "../../api/client";
import type { PageSummary } from "../../api/client";
import { useReviewStore } from "../../store/reviewStore";
import styles from "./OriginalThumb.module.css";

interface OriginalThumbProps {
  docId: string;
  page: PageSummary | undefined;
}

/**
 * Right-rail thumbnail of the clean original page. Clicking enters
 * Diff View so the reviewer can read underlying text that boxes cover.
 */
export function OriginalThumb({ docId, page }: OriginalThumbProps) {
  const setViewMode = useReviewStore((s) => s.setViewMode);
  if (!page) return null;

  return (
    <button
      type="button"
      className={styles.thumb}
      onClick={() => setViewMode("diff")}
      aria-label="Open diff view — clean original vs annotated"
      title="Diff View (click) · Esc to exit"
    >
      <div className={styles.head}>
        <div className={styles.ttl}>ORIGINAL</div>
        <div className={styles.hint}>OPEN DIFF →</div>
      </div>
      <div
        className={styles.imgWrap}
        style={{ aspectRatio: `${page.width_px} / ${page.height_px}` }}
      >
        <img
          src={pageImageUrl(docId, page.page_number)}
          alt={`Page ${page.page_number} — original`}
          draggable={false}
        />
      </div>
    </button>
  );
}
