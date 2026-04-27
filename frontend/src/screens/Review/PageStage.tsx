import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Rect, Image as KonvaImage, Transformer } from "react-konva";
import type Konva from "konva";
import type { DetectedObject } from "../../api/client";
import { colorForLabel, rgba } from "./regionColors";

interface PageStageProps {
  imageUrl: string;
  objects: DetectedObject[];
  originalWidth: number;
  originalHeight: number;
  displayWidth: number;
  selectedIds: Set<string>;
  pageId: string;
  mode: "select" | "draw";
  onSelect: (id: string | null) => void;
  // Bbox edits — coords are returned in ORIGINAL pixel space (the same space
  // backend stores), already clamped to the page rect. Caller dispatches
  // through useObjectEdits.
  onBboxChange: (objectId: string, kind: "move" | "resize", bbox: BboxPx) => void;
  onCreate: (pageId: string, bbox: BboxPx) => void;
}

export interface BboxPx {
  bbox_x1: number;
  bbox_y1: number;
  bbox_x2: number;
  bbox_y2: number;
}

const MIN_BBOX_PX = 6; // Reject sub-pixel-noise drags so we don't spam tiny boxes.

/**
 * Konva renderer for the PDF page + region rects + interactive editing.
 *
 * The rendering split is intentional:
 *   - Konva (this file) draws the page bitmap, all non-selected rects, and
 *     a transparent draggable rect over the SELECTED region with an attached
 *     Transformer (8 resize handles + drag-to-move).
 *   - HTML RegionOverlay paints the selected region's electric shimmer / tag
 *     pill on top — CSS keyframes that Konva can't express.
 *
 * The HTML overlay is `pointer-events: none` over the selected region so the
 * Konva drag/resize handles underneath capture mouse input.
 *
 * In `mode="draw"` the page becomes a marquee surface: pointer-down on the
 * page (not on a rect) starts a rubber-band selection rendered live; pointer-up
 * commits it as a new manual region via onCreate.
 */
export function PageStage({
  imageUrl,
  objects,
  originalWidth,
  originalHeight,
  displayWidth,
  selectedIds,
  pageId,
  mode,
  onSelect,
  onBboxChange,
  onCreate,
}: PageStageProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const scale = displayWidth / originalWidth;
  const displayHeight = originalHeight * scale;

  // Refs for the selected rect + its transformer so we can attach them
  // imperatively after first render (react-konva doesn't have declarative
  // transformer-target binding).
  const selectedRectRef = useRef<Konva.Rect | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);

  // Live marquee state for draw mode. Stored in display-pixel coords; converted
  // to original-pixel coords on commit via onCreate.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const img = new window.Image();
    img.src = imageUrl;
    img.onload = () => {
      imgRef.current = img;
      setImage(img);
    };
  }, [imageUrl]);

  // Pull selected object out of the list — there's at most one in current UI
  // (multi-select isn't surfaced yet). Put after the rest in z-order so it's on top.
  const selectedObject = objects.find((o) => selectedIds.has(o.id)) ?? null;

  // Bind transformer to the selected rect after each render where selection changes.
  useEffect(() => {
    if (!transformerRef.current) return;
    if (selectedRectRef.current && selectedObject && mode === "select") {
      transformerRef.current.nodes([selectedRectRef.current]);
    } else {
      transformerRef.current.nodes([]);
    }
    transformerRef.current.getLayer()?.batchDraw();
  }, [selectedObject, mode, displayWidth]);

  function clampToPage(b: BboxPx): BboxPx {
    return {
      bbox_x1: Math.max(0, Math.min(originalWidth, b.bbox_x1)),
      bbox_y1: Math.max(0, Math.min(originalHeight, b.bbox_y1)),
      bbox_x2: Math.max(0, Math.min(originalWidth, b.bbox_x2)),
      bbox_y2: Math.max(0, Math.min(originalHeight, b.bbox_y2)),
    };
  }

  return (
    <Stage
      width={displayWidth}
      height={displayHeight}
      style={{ cursor: mode === "draw" ? "crosshair" : "default" }}
      onMouseDown={(e) => {
        if (mode !== "draw") return;
        // Only start a marquee if pointer-down is on blank page (or the page
        // image), not on top of an existing rect — that lets the user still
        // click rects in draw mode if they want.
        const stage = e.target.getStage();
        if (!stage) return;
        const target = e.target;
        const isOnPage = target === stage || target.name?.() === "page-bg";
        if (!isOnPage) return;
        const pos = stage.getPointerPosition();
        if (!pos) return;
        drawStart.current = pos;
        setMarquee({ x: pos.x, y: pos.y, w: 0, h: 0 });
      }}
      onMouseMove={(e) => {
        if (mode !== "draw" || !drawStart.current) return;
        const stage = e.target.getStage();
        if (!stage) return;
        const pos = stage.getPointerPosition();
        if (!pos) return;
        const x = Math.min(drawStart.current.x, pos.x);
        const y = Math.min(drawStart.current.y, pos.y);
        const w = Math.abs(pos.x - drawStart.current.x);
        const h = Math.abs(pos.y - drawStart.current.y);
        setMarquee({ x, y, w, h });
      }}
      onMouseUp={() => {
        if (mode !== "draw" || !drawStart.current) return;
        if (marquee && marquee.w >= MIN_BBOX_PX && marquee.h >= MIN_BBOX_PX) {
          const bbox = clampToPage({
            bbox_x1: marquee.x / scale,
            bbox_y1: marquee.y / scale,
            bbox_x2: (marquee.x + marquee.w) / scale,
            bbox_y2: (marquee.y + marquee.h) / scale,
          });
          onCreate(pageId, bbox);
        }
        drawStart.current = null;
        setMarquee(null);
      }}
      onClick={(e) => {
        // In select mode, click on blank page → deselect. (In draw mode the
        // mousedown/up handler owns the gesture; don't deselect here.)
        if (mode === "draw") return;
        if (e.target === e.target.getStage() || e.target.name?.() === "page-bg") {
          onSelect(null);
        }
      }}
    >
      <Layer>
        {image && (
          <KonvaImage
            image={image}
            width={displayWidth}
            height={displayHeight}
            name="page-bg"
          />
        )}

        {/* Non-selected rects */}
        {objects.map((obj) => {
          if (selectedIds.has(obj.id)) return null;
          const color = colorForLabel(obj.label);
          const x = obj.bbox_x1 * scale;
          const y = obj.bbox_y1 * scale;
          const w = (obj.bbox_x2 - obj.bbox_x1) * scale;
          const h = (obj.bbox_y2 - obj.bbox_y1) * scale;
          const style = rectStyleFor(obj.status, color);

          return (
            <Rect
              key={obj.id}
              x={x}
              y={y}
              width={w}
              height={h}
              stroke={style.stroke}
              strokeWidth={style.strokeWidth}
              fill={style.fill}
              cornerRadius={3}
              dash={style.dash}
              opacity={style.opacity}
              shadowColor={color}
              shadowBlur={style.shadowBlur}
              shadowOpacity={style.shadowOpacity}
              listening={mode === "select"}
              onClick={(e) => {
                if (mode !== "select") return;
                e.cancelBubble = true;
                onSelect(obj.id);
              }}
              onTap={(e) => {
                if (mode !== "select") return;
                e.cancelBubble = true;
                onSelect(obj.id);
              }}
            />
          );
        })}

        {/* Selected rect — invisible visual (HTML overlay paints the pretty
            box on top), but draggable + resizable via the Transformer. */}
        {selectedObject && (
          <Rect
            ref={selectedRectRef}
            x={selectedObject.bbox_x1 * scale}
            y={selectedObject.bbox_y1 * scale}
            width={(selectedObject.bbox_x2 - selectedObject.bbox_x1) * scale}
            height={(selectedObject.bbox_y2 - selectedObject.bbox_y1) * scale}
            fill="rgba(0,0,0,0.001)"  // near-invisible but still hit-testable
            draggable={mode === "select"}
            listening={mode === "select"}
            onDragEnd={(e) => {
              const node = e.target;
              const newX = node.x();
              const newY = node.y();
              const w = node.width();
              const h = node.height();
              const bbox = clampToPage({
                bbox_x1: newX / scale,
                bbox_y1: newY / scale,
                bbox_x2: (newX + w) / scale,
                bbox_y2: (newY + h) / scale,
              });
              onBboxChange(selectedObject.id, "move", bbox);
            }}
            onTransformEnd={(e) => {
              const node = e.target as Konva.Rect;
              // Bake scale into width/height so subsequent drags don't compound.
              const newW = node.width() * node.scaleX();
              const newH = node.height() * node.scaleY();
              node.scaleX(1);
              node.scaleY(1);
              node.width(newW);
              node.height(newH);
              const bbox = clampToPage({
                bbox_x1: node.x() / scale,
                bbox_y1: node.y() / scale,
                bbox_x2: (node.x() + newW) / scale,
                bbox_y2: (node.y() + newH) / scale,
              });
              onBboxChange(selectedObject.id, "resize", bbox);
            }}
          />
        )}

        {/* Transformer — 8 resize handles + rotation disabled (bboxes are AABB) */}
        <Transformer
          ref={transformerRef}
          rotateEnabled={false}
          flipEnabled={false}
          ignoreStroke
          anchorSize={9}
          anchorStroke="rgba(207, 230, 255, 0.95)"
          anchorFill="rgba(20, 18, 16, 0.95)"
          anchorCornerRadius={2}
          borderStroke="rgba(207, 230, 255, 0.55)"
          borderDash={[4, 3]}
          // Reject zero-area / negative drags
          boundBoxFunc={(_oldBox, newBox) => {
            if (newBox.width < MIN_BBOX_PX || newBox.height < MIN_BBOX_PX) {
              return _oldBox;
            }
            return newBox;
          }}
        />

        {/* Live draw marquee */}
        {marquee && marquee.w > 0 && marquee.h > 0 && (
          <Rect
            x={marquee.x}
            y={marquee.y}
            width={marquee.w}
            height={marquee.h}
            stroke="rgba(207, 230, 255, 0.9)"
            strokeWidth={1.5}
            dash={[6, 4]}
            fill="rgba(207, 230, 255, 0.10)"
            cornerRadius={2}
            listening={false}
          />
        )}
      </Layer>
    </Stage>
  );
}

interface RectStyle {
  stroke: string;
  strokeWidth: number;
  fill: string;
  dash?: number[];
  opacity: number;
  shadowBlur: number;
  shadowOpacity: number;
}

function rectStyleFor(status: string, color: string): RectStyle {
  switch (status) {
    case "confirmed": // approved
      return {
        stroke: color,
        strokeWidth: 2.5,
        fill: rgba(color, 0.28),
        opacity: 1,
        shadowBlur: 18,
        shadowOpacity: 0.45,
      };
    case "rejected":
      return {
        stroke: "rgba(140, 130, 120, 1)",
        strokeWidth: 1.5,
        fill: "rgba(80, 75, 70, 0.12)",
        dash: [6, 4],
        opacity: 0.55,
        shadowBlur: 0,
        shadowOpacity: 0,
      };
    case "unreviewed":
    default:
      return {
        stroke: rgba(color, 0.75),
        strokeWidth: 2,
        fill: rgba(color, 0.14),
        opacity: 1,
        shadowBlur: 0,
        shadowOpacity: 0,
      };
  }
}
