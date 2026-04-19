import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Rect, Text, Image as KonvaImage } from "react-konva";
import type { DetectedObject } from "../api/client";

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
  imageUrl: string;
  objects: DetectedObject[];
  originalWidth: number;
  originalHeight: number;
  displayWidth: number;
}

export function PageCanvas({ imageUrl, objects, originalWidth, originalHeight, displayWidth }: Props) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const scale = displayWidth / originalWidth;
  const displayHeight = originalHeight * scale;

  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.src = imageUrl;
    img.onload = () => {
      imgRef.current = img;
      setImage(img);
    };
  }, [imageUrl]);

  return (
    <Stage width={displayWidth} height={displayHeight}>
      <Layer>
        {image && (
          <KonvaImage
            image={image}
            width={displayWidth}
            height={displayHeight}
          />
        )}
        {objects.map((obj) => {
          const color = LABEL_COLORS[obj.label] ?? "#94a3b8";
          const x = obj.bbox_x1 * scale;
          const y = obj.bbox_y1 * scale;
          const w = (obj.bbox_x2 - obj.bbox_x1) * scale;
          const h = (obj.bbox_y2 - obj.bbox_y1) * scale;

          return (
            <Rect
              key={`box-${obj.id}`}
              x={x}
              y={y}
              width={w}
              height={h}
              stroke={color}
              strokeWidth={2}
              fill={hexToRgba(color, 0.08)}
              cornerRadius={2}
            />
          );
        })}
        {objects.map((obj) => {
          const color = LABEL_COLORS[obj.label] ?? "#94a3b8";
          const x = obj.bbox_x1 * scale;
          const y = obj.bbox_y1 * scale;

          const labelText = obj.label.replace(/_/g, " ");
          const confText = obj.confidence != null ? ` ${(obj.confidence * 100).toFixed(0)}%` : "";
          const badgeText = `${labelText}${confText}`;
          const fontSize = Math.max(9, Math.min(12, displayWidth * 0.015));
          const badgeWidth = badgeText.length * fontSize * 0.6 + 8;
          const badgeHeight = fontSize + 6;

          return [
            <Rect
              key={`badge-bg-${obj.id}`}
              x={x}
              y={y - badgeHeight}
              width={badgeWidth}
              height={badgeHeight}
              fill={color}
              cornerRadius={[2, 2, 0, 0]}
            />,
            <Text
              key={`badge-text-${obj.id}`}
              x={x + 4}
              y={y - badgeHeight + 3}
              text={badgeText}
              fontSize={fontSize}
              fill="#fff"
              fontFamily="system-ui, sans-serif"
              fontStyle="bold"
            />,
          ];
        })}
      </Layer>
    </Stage>
  );
}
