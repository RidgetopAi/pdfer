import { useEffect, useRef, useState } from "react";
import { PageStage } from "./PageStage";
import type { BboxPx } from "./PageStage";

export type { BboxPx } from "./PageStage";
import { RegionOverlay } from "./RegionOverlay";
import { useReviewStore } from "../../store/reviewStore";
import type { DetectedObject, PageSummary } from "../../api/client";
import { pageImageUrl } from "../../api/client";
import styles from "./PdfStage.module.css";

interface PdfStageProps {
  docId: string;
  page: PageSummary | undefined;
  objects: DetectedObject[];
  onBboxChange: (objectId: string, kind: "move" | "resize", bbox: BboxPx) => void;
  onCreate: (pageId: string, bbox: BboxPx) => void;
}

/**
 * Centered PDF stage — backlit halo + ambient rim lighting wrapping the
 * Konva page renderer. The HTML RegionOverlay is layered on top for the
 * electric selected-region effect that Konva can't express.
 */
export function PdfStage({ docId, page, objects, onBboxChange, onCreate }: PdfStageProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [displayWidth, setDisplayWidth] = useState<number>(640);

  const selectedObjectIds = useReviewStore((s) => s.selectedObjectIds);
  const selectObject = useReviewStore((s) => s.selectObject);
  const deselectAll = useReviewStore((s) => s.deselectAll);
  const mode = useReviewStore((s) => s.mode);

  useEffect(() => {
    if (!wrapRef.current || !page) return;
    const el = wrapRef.current;
    const measure = () => {
      const available = el.clientWidth - 48;
      const availableH = el.clientHeight - 48;
      if (available <= 0 || availableH <= 0) return;
      const byWidth = Math.min(available, 820);
      const heightIfWidth = (page.height_px / page.width_px) * byWidth;
      if (heightIfWidth > availableH) {
        setDisplayWidth((availableH / page.height_px) * page.width_px);
      } else {
        setDisplayWidth(byWidth);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [page]);

  return (
    <div className={styles.stage} ref={wrapRef}>
      {!page ? (
        <div className={styles.empty}>
          <strong>No page available</strong>
          This document hasn't finished ingesting yet, or has no pages.
        </div>
      ) : (
        <div className={styles.halo}>
          <div className={styles.page} style={{ position: "relative" }}>
            <PageStage
              imageUrl={pageImageUrl(docId, page.page_number)}
              objects={objects}
              originalWidth={page.width_px}
              originalHeight={page.height_px}
              displayWidth={displayWidth}
              selectedIds={selectedObjectIds}
              pageId={page.id}
              mode={mode}
              onSelect={(id) => {
                if (id == null) deselectAll();
                else selectObject(id);
              }}
              onBboxChange={onBboxChange}
              onCreate={onCreate}
            />
            <RegionOverlay
              objects={objects}
              selectedIds={selectedObjectIds}
              scale={displayWidth / page.width_px}
              displayWidth={displayWidth}
              displayHeight={(page.height_px * displayWidth) / page.width_px}
              onDeselect={deselectAll}
            />
          </div>
        </div>
      )}
    </div>
  );
}
