import { useEffect, useRef, useState } from "react";
import { pageImageUrl } from "../../api/client";
import type { DetectedObject, PageSummary } from "../../api/client";
import { PdfStage, type BboxPx } from "./PdfStage";
import { useReviewStore } from "../../store/reviewStore";
import styles from "./DiffView.module.css";

interface DiffViewProps {
  docId: string;
  page: PageSummary | undefined;
  objects: DetectedObject[];
  onBboxChange: (objectId: string, kind: "move" | "resize", bbox: BboxPx) => void;
  onCreate: (pageId: string, bbox: BboxPx) => void;
}

/**
 * Two-pane comparison: clean original PDF page on the left, the
 * annotated (Konva + region overlay) stage on the right. Both panes
 * read from reviewStore.currentPageIndex via props, so page nav moves
 * both together. PdfStage self-measures from its container — we just
 * give it a flex cell and it fits.
 */
export function DiffView({ docId, page, objects, onBboxChange, onCreate }: DiffViewProps) {
  return (
    <div className={styles.wrap}>
      <div className={styles.pane}>
        <div className={styles.label}>
          <span className={styles.dot} />
          ORIGINAL
        </div>
        <OriginalPane docId={docId} page={page} />
      </div>

      <div className={styles.pane}>
        <div className={styles.label}>
          <span className={styles.dot} />
          ANNOTATED
        </div>
        <div className={styles.stageSlot}>
          <PdfStage
            docId={docId}
            page={page}
            objects={objects}
            onBboxChange={onBboxChange}
            onCreate={onCreate}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Mirrors PdfStage's fit-to-container logic for a raw <img> — keeps
 * the two panes visually aligned at the same scale by sharing the
 * same width-measuring algorithm.
 */
function OriginalPane({
  docId,
  page,
}: {
  docId: string;
  page: PageSummary | undefined;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [displayWidth, setDisplayWidth] = useState(520);
  const userZoom = useReviewStore((s) => s.userZoom);

  useEffect(() => {
    if (!wrapRef.current || !page) return;
    const el = wrapRef.current;
    const measure = () => {
      const availW = el.clientWidth - 48;
      const availH = el.clientHeight - 48;
      if (availW <= 0 || availH <= 0) return;
      const byWidth = Math.min(availW, 820);
      const heightIfWidth = (page.height_px / page.width_px) * byWidth;
      const fit = heightIfWidth > availH
        ? (availH / page.height_px) * page.width_px
        : byWidth;
      setDisplayWidth(fit * userZoom);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page, userZoom]);

  if (!page) {
    return (
      <div className={styles.empty}>
        <strong>No page available</strong>
        This document hasn't finished ingesting yet.
      </div>
    );
  }

  const h = (page.height_px * displayWidth) / page.width_px;

  return (
    <div className={styles.stageSlot} ref={wrapRef}>
      <div className={styles.halo}>
        <div className={styles.page} style={{ width: displayWidth, height: h }}>
          <img
            src={pageImageUrl(docId, page.page_number)}
            alt={`Page ${page.page_number} — original`}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}
