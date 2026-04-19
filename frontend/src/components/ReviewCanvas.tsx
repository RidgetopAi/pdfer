import { useEffect, useRef, useState, useCallback } from "react";
import {
  Stage,
  Layer,
  Rect,
  Text,
  Image as KonvaImage,
  Transformer,
  Group,
} from "react-konva";
import type Konva from "konva";
import type { DetectedObject, EditAction, PageSummary } from "../api/client";
import { pageImageUrl } from "../api/client";
import { useReviewStore, type InteractionMode } from "../store/reviewStore";

const LABEL_COLORS: Record<string, string> = {
  title: "#f59e0b",
  section_heading: "#eab308",
  paragraph: "#3b82f6",
  table: "#8b5cf6",
  figure: "#22c55e",
  caption: "#14b8a6",
  footnote: "#6b7280",
  list: "#06b6d4",
  formula: "#ec4899",
  page_header: "#64748b",
  page_footer: "#64748b",
  watermark: "#94a3b8",
};

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

interface Props {
  documentId: string;
  page: PageSummary;
  objects: DetectedObject[];
  selectedIds: Set<string>;
  mode: InteractionMode;
  onEdit: (edits: EditAction[]) => void;
}

const CANVAS_WIDTH = 800;

export function ReviewCanvas({
  documentId,
  page,
  objects,
  selectedIds,
  mode,
  onEdit,
}: Props) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const objectRefs = useRef<Map<string, Konva.Rect>>(new Map());
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(
    null
  );
  const [drawRect, setDrawRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  const { selectObject, deselectAll } = useReviewStore();

  const scale = CANVAS_WIDTH / page.width_px;
  const displayHeight = page.height_px * scale;
  const imageUrl = pageImageUrl(documentId, page.page_number);

  // Load image
  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.src = imageUrl;
    img.onload = () => setImage(img);
  }, [imageUrl]);

  // Attach transformer to selected nodes
  useEffect(() => {
    if (!trRef.current) return;
    const selectedNodes: Konva.Node[] = [];
    for (const id of selectedIds) {
      const node = objectRefs.current.get(id);
      if (node) selectedNodes.push(node);
    }
    trRef.current.nodes(selectedNodes);
    trRef.current.getLayer()?.batchDraw();
  }, [selectedIds, objects]);

  // Handle transform end (resize/move)
  const handleTransformEnd = useCallback(
    (obj: DetectedObject, node: Konva.Rect) => {
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();

      // Convert back to original pixel coordinates
      const newX1 = node.x() / scale;
      const newY1 = node.y() / scale;
      const newX2 = newX1 + (node.width() * scaleX) / scale;
      const newY2 = newY1 + (node.height() * scaleY) / scale;

      // Reset scale
      node.scaleX(1);
      node.scaleY(1);

      onEdit([
        {
          action: "resize",
          object_id: obj.id,
          bbox_x1: Math.round(newX1),
          bbox_y1: Math.round(newY1),
          bbox_x2: Math.round(newX2),
          bbox_y2: Math.round(newY2),
        },
      ]);
    },
    [scale, onEdit]
  );

  // Handle drag end (move)
  const handleDragEnd = useCallback(
    (obj: DetectedObject, node: Konva.Rect) => {
      const newX1 = node.x() / scale;
      const newY1 = node.y() / scale;
      const w = obj.bbox_x2 - obj.bbox_x1;
      const h = obj.bbox_y2 - obj.bbox_y1;

      onEdit([
        {
          action: "move",
          object_id: obj.id,
          bbox_x1: Math.round(newX1),
          bbox_y1: Math.round(newY1),
          bbox_x2: Math.round(newX1 + w),
          bbox_y2: Math.round(newY1 + h),
        },
      ]);
    },
    [scale, onEdit]
  );

  // Stage click for deselect
  const handleStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (e.target === stageRef.current || e.target.getClassName() === "Image") {
        deselectAll();
      }
    },
    [deselectAll]
  );

  // Drawing handlers
  const handleMouseDown = useCallback(
    (_e: Konva.KonvaEventObject<MouseEvent>) => {
      if (mode !== "draw") return;
      const stage = stageRef.current;
      if (!stage) return;
      const pos = stage.getPointerPosition();
      if (!pos) return;
      setDrawStart(pos);
      setDrawRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
    },
    [mode]
  );

  const handleMouseMove = useCallback(
    (_e: Konva.KonvaEventObject<MouseEvent>) => {
      if (mode !== "draw" || !drawStart) return;
      const stage = stageRef.current;
      if (!stage) return;
      const pos = stage.getPointerPosition();
      if (!pos) return;
      setDrawRect({
        x: Math.min(drawStart.x, pos.x),
        y: Math.min(drawStart.y, pos.y),
        w: Math.abs(pos.x - drawStart.x),
        h: Math.abs(pos.y - drawStart.y),
      });
    },
    [mode, drawStart]
  );

  const handleMouseUp = useCallback(() => {
    if (mode !== "draw" || !drawRect || !drawStart) return;
    setDrawStart(null);

    // Minimum size check (at least 10px in display coordinates)
    if (drawRect.w < 10 || drawRect.h < 10) {
      setDrawRect(null);
      return;
    }

    // Convert to original pixel coordinates
    const bbox_x1 = Math.round(drawRect.x / scale);
    const bbox_y1 = Math.round(drawRect.y / scale);
    const bbox_x2 = Math.round((drawRect.x + drawRect.w) / scale);
    const bbox_y2 = Math.round((drawRect.y + drawRect.h) / scale);

    onEdit([
      {
        action: "create",
        page_id: page.id,
        label: "paragraph",
        bbox_x1,
        bbox_y1,
        bbox_x2,
        bbox_y2,
      },
    ]);

    setDrawRect(null);
    useReviewStore.getState().setMode("select");
  }, [mode, drawRect, drawStart, scale, page.id, onEdit]);

  function getObjectVisualStyle(obj: DetectedObject) {
    const color = LABEL_COLORS[obj.label] ?? "#94a3b8";
    const isSelected = selectedIds.has(obj.id);

    if (obj.status === "confirmed") {
      return {
        stroke: "#22c55e",
        strokeWidth: isSelected ? 3 : 1.5,
        dash: [6, 3],
        fill: hexToRgba("#22c55e", 0.04),
      };
    }
    if (obj.status === "rejected") {
      return {
        stroke: "#ef4444",
        strokeWidth: isSelected ? 3 : 1.5,
        dash: [4, 4],
        fill: hexToRgba("#ef4444", 0.06),
      };
    }
    // Unreviewed
    return {
      stroke: color,
      strokeWidth: isSelected ? 3 : 2,
      dash: undefined as number[] | undefined,
      fill: hexToRgba(color, isSelected ? 0.15 : 0.08),
    };
  }

  return (
    <Stage
      ref={stageRef}
      width={CANVAS_WIDTH}
      height={displayHeight}
      onClick={handleStageClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{ cursor: mode === "draw" ? "crosshair" : "default" }}
    >
      <Layer>
        {/* Page image */}
        {image && (
          <KonvaImage image={image} width={CANVAS_WIDTH} height={displayHeight} />
        )}

        {/* Objects are rendered largest-first so smaller / nested boxes sit on top
            and can always be clicked. The currently selected object is rendered
            last (above everything) so it has clear focus. */}
        {(() => {
          const area = (o: DetectedObject) =>
            (o.bbox_x2 - o.bbox_x1) * (o.bbox_y2 - o.bbox_y1);
          const sorted = [...objects].sort((a, b) => {
            const aSel = selectedIds.has(a.id) ? 1 : 0;
            const bSel = selectedIds.has(b.id) ? 1 : 0;
            if (aSel !== bSel) return aSel - bSel; // selected last (on top)
            return area(b) - area(a); // larger first, smaller on top
          });

          return sorted.map((obj) => {
            const x = obj.bbox_x1 * scale;
            const y = obj.bbox_y1 * scale;
            const w = (obj.bbox_x2 - obj.bbox_x1) * scale;
            const h = (obj.bbox_y2 - obj.bbox_y1) * scale;
            const style = getObjectVisualStyle(obj);
            const isSelected = selectedIds.has(obj.id);
            const color = LABEL_COLORS[obj.label] ?? "#94a3b8";

            const labelText = obj.label.replace(/_/g, " ");
            const confText =
              obj.confidence != null
                ? ` ${(obj.confidence * 100).toFixed(0)}%`
                : "";
            const statusIcon =
              obj.status === "confirmed"
                ? " \u2713"
                : obj.status === "rejected"
                  ? " \u2717"
                  : "";
            const badgeText = `${labelText}${confText}${statusIcon}`;
            const fontSize = 10;
            const badgeWidth = badgeText.length * fontSize * 0.58 + 8;
            const badgeHeight = fontSize + 6;

            // Place the badge above the box when there is room, otherwise tuck
            // it inside the top-left corner so it never covers page text below.
            const badgeAbove = y >= badgeHeight + 1;
            const badgeY = badgeAbove ? y - badgeHeight : y;

            const handleSelect = (
              e: Konva.KonvaEventObject<MouseEvent | TouchEvent>
            ) => {
              e.cancelBubble = true;
              const shift =
                "shiftKey" in e.evt ? (e.evt as MouseEvent).shiftKey : false;
              selectObject(obj.id, shift);
            };
            const handleConfirm = (
              e: Konva.KonvaEventObject<MouseEvent | TouchEvent>
            ) => {
              e.cancelBubble = true;
              onEdit([{ action: "confirm", object_id: obj.id }]);
            };

            // Rejected X marker (centered, non-interactive)
            let rejectedMark: React.ReactNode = null;
            if (obj.status === "rejected") {
              const cx = x + w / 2;
              const cy = y + h / 2;
              const sz = Math.min(w, h) * 0.3;
              rejectedMark = (
                <Text
                  x={cx - sz / 2}
                  y={cy - sz / 2}
                  text="X"
                  fontSize={sz}
                  fill="#ef4444"
                  fontStyle="bold"
                  fontFamily="system-ui, sans-serif"
                  opacity={0.6}
                  listening={false}
                />
              );
            }

            return (
              <Group key={`obj-group-${obj.id}`}>
                <Rect
                  ref={(node) => {
                    if (node) objectRefs.current.set(obj.id, node);
                  }}
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  stroke={style.stroke}
                  strokeWidth={style.strokeWidth}
                  dash={style.dash}
                  fill={style.fill}
                  cornerRadius={2}
                  draggable={isSelected && mode === "select"}
                  onClick={handleSelect}
                  onTap={handleSelect}
                  onDblClick={handleConfirm}
                  onDragEnd={(e) => handleDragEnd(obj, e.target as Konva.Rect)}
                  onTransformEnd={(e) =>
                    handleTransformEnd(obj, e.target as Konva.Rect)
                  }
                />
                {rejectedMark}
                <Group
                  onClick={handleSelect}
                  onTap={handleSelect}
                  onDblClick={handleConfirm}
                >
                  <Rect
                    x={x}
                    y={badgeY}
                    width={badgeWidth}
                    height={badgeHeight}
                    fill={
                      obj.status === "confirmed"
                        ? "#166534"
                        : obj.status === "rejected"
                          ? "#7f1d1d"
                          : color
                    }
                    cornerRadius={
                      badgeAbove ? [2, 2, 0, 0] : [0, 0, 2, 2]
                    }
                    opacity={isSelected ? 1 : 0.85}
                  />
                  <Text
                    x={x + 4}
                    y={badgeY + 3}
                    text={badgeText}
                    fontSize={fontSize}
                    fill="#fff"
                    fontFamily="system-ui, sans-serif"
                    fontStyle="bold"
                    listening={false}
                  />
                </Group>
              </Group>
            );
          });
        })()}

        {/* Draw rect preview */}
        {drawRect && drawRect.w > 0 && drawRect.h > 0 && (
          <Rect
            x={drawRect.x}
            y={drawRect.y}
            width={drawRect.w}
            height={drawRect.h}
            stroke="#f59e0b"
            strokeWidth={2}
            dash={[4, 4]}
            fill={hexToRgba("#f59e0b", 0.15)}
          />
        )}

        {/* Transformer for selected objects */}
        <Transformer
          ref={trRef}
          rotateEnabled={false}
          keepRatio={false}
          borderStroke="#3b82f6"
          anchorStroke="#3b82f6"
          anchorFill="#1e293b"
          anchorSize={8}
          enabledAnchors={[
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right",
            "middle-left",
            "middle-right",
            "top-center",
            "bottom-center",
          ]}
        />
      </Layer>
    </Stage>
  );
}
