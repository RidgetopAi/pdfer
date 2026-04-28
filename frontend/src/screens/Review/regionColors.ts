/**
 * Map detected object labels → UI region type families.
 * Keeps the saturated, scan-friendly palette from the locked design.
 */
export type RegionKind = "text" | "table" | "form" | "signature" | "image";

export const LABEL_TO_KIND: Record<string, RegionKind> = {
  title: "text",
  section_heading: "text",
  paragraph: "text",
  caption: "text",
  footnote: "text",
  list: "text",
  page_header: "text",
  page_footer: "text",
  watermark: "text",
  table: "table",
  figure: "image",
  formula: "form",
};

// Canonical ordering for the type picker — most common first within each
// kind cluster so the dropdown reads top-to-bottom by frequency-of-use.
export const ALL_LABELS: readonly string[] = [
  "paragraph",
  "title",
  "section_heading",
  "list",
  "caption",
  "footnote",
  "table",
  "figure",
  "formula",
  "page_header",
  "page_footer",
  "watermark",
] as const;

export const KIND_COLOR: Record<RegionKind, string> = {
  text:      "rgb(110, 180, 255)",
  table:     "rgb(255, 170, 60)",
  form:      "rgb(255, 100, 140)",
  signature: "rgb(70, 230, 200)",
  image:     "rgb(190, 130, 255)",
};

export function kindForLabel(label: string): RegionKind {
  return LABEL_TO_KIND[label] ?? "text";
}

export function colorForLabel(label: string): string {
  return KIND_COLOR[kindForLabel(label)];
}

/** Translate CSS rgb() string → [r,g,b] for Konva fill math. */
export function parseRgb(rgb: string): [number, number, number] {
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return [255, 255, 255];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

export function rgba(rgb: string, alpha: number): string {
  const [r, g, b] = parseRgb(rgb);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
