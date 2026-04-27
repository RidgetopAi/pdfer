import type { CSSProperties } from "react";
import type { DetectedObject } from "../../api/client";
import { colorForLabel, kindForLabel } from "./regionColors";
import { useReviewStore } from "../../store/reviewStore";
import styles from "./RegionOverlay.module.css";

interface RegionOverlayProps {
  objects: DetectedObject[];
  selectedIds: Set<string>;
  scale: number;
  displayWidth: number;
  displayHeight: number;
  onDeselect: () => void;
}

/**
 * Renders the SELECTED object(s) on an HTML layer positioned over the
 * Konva stage. Uses CSS box-shadow + keyframes for the electric backlit
 * effect and scan shimmer — impossible in Konva.
 */
export function RegionOverlay({
  objects,
  selectedIds,
  scale,
  displayWidth,
  displayHeight,
  onDeselect,
}: RegionOverlayProps) {
  const flashIds = useReviewStore((s) => s.flashObjectIds);
  const layerStyle: CSSProperties = {
    width: displayWidth,
    height: displayHeight,
  };

  return (
    <div
      className={styles.layer}
      style={layerStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDeselect();
      }}
    >
      {/* Flash bursts — short-lived glow on regions that just received an edit */}
      {objects
        .filter((o) => flashIds.has(o.id))
        .map((obj) => {
          const color = colorForLabel(obj.label);
          const x = obj.bbox_x1 * scale;
          const y = obj.bbox_y1 * scale;
          const w = (obj.bbox_x2 - obj.bbox_x1) * scale;
          const h = (obj.bbox_y2 - obj.bbox_y1) * scale;
          return (
            <div
              key={`flash-${obj.id}`}
              className={styles.flash}
              style={{ left: x, top: y, width: w, height: h, ["--tint" as string]: color }}
            />
          );
        })}

      {/* Non-selected regions — tag labels only (Konva draws the rect) */}
      {objects
        .filter((o) => !selectedIds.has(o.id))
        .map((obj) => {
          const color = colorForLabel(obj.label);
          const kind = kindForLabel(obj.label);
          const x = obj.bbox_x1 * scale;
          const y = obj.bbox_y1 * scale;
          const w = (obj.bbox_x2 - obj.bbox_x1) * scale;
          const h = (obj.bbox_y2 - obj.bbox_y1) * scale;
          const style: CSSProperties = {
            left: x,
            top: y,
            width: w,
            height: h,
            ["--tint" as string]: color,
          };
          const rejected = obj.status === "rejected";
          const tagClass = rejected
            ? `${styles.tag} ${styles.tagRejected}`
            : styles.tag;
          return (
            <div key={`tag-${obj.id}`} className={styles.tagAnchor} style={style}>
              <div className={tagClass}>
                <span className={styles.dot} />
                {tagTextFor(kind, obj.label)}
              </div>
            </div>
          );
        })}

      {/* Selected regions — electric backlit treatment */}
      {objects
        .filter((o) => selectedIds.has(o.id))
        .map((obj) => {
          const color = colorForLabel(obj.label);
          const kind = kindForLabel(obj.label);
          const x = obj.bbox_x1 * scale;
          const y = obj.bbox_y1 * scale;
          const w = (obj.bbox_x2 - obj.bbox_x1) * scale;
          const h = (obj.bbox_y2 - obj.bbox_y1) * scale;
          const style: CSSProperties = {
            left: x,
            top: y,
            width: w,
            height: h,
            ["--tint" as string]: color,
          };
          return (
            <div key={obj.id} className={styles.region} style={style}>
              <div className={styles.tag}>
                <span className={styles.dot} />
                {tagTextFor(kind, obj.label)}
              </div>
            </div>
          );
        })}
    </div>
  );
}

function tagTextFor(kind: string, label: string): string {
  const displayLabel = label.replace(/_/g, " ").toUpperCase();
  const displayKind = kind.toUpperCase();
  if (displayLabel === displayKind) return displayKind;
  return `${displayKind} · ${displayLabel}`;
}
