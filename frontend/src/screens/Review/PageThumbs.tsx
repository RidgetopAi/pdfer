import type { PageSummary } from "../../api/client";
import { thumbUrl } from "../../api/client";
import styles from "./PageThumbs.module.css";

interface PageThumbsProps {
  pages: PageSummary[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function PageThumbs({ pages, activeIndex, onSelect }: PageThumbsProps) {
  if (pages.length === 0) return null;
  return (
    <div className={styles.block}>
      <div className={styles.title}>PAGES · {pages.length}</div>
      <div className={styles.grid}>
        {pages.map((p, i) => (
          <button
            key={p.id}
            className={`${styles.thumb} ${i === activeIndex ? styles.active : ""}`}
            onClick={() => onSelect(i)}
            title={`Page ${p.page_number}`}
          >
            {p.thumb_url && <img src={thumbUrl(p.thumb_url)} alt="" />}
            <span className={styles.n}>
              {String(p.page_number).padStart(2, "0")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
