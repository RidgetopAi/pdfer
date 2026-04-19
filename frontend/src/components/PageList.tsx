import { thumbUrl, type PageSummary, type DetectionResponse } from "../api/client";

interface Props {
  documentId: string;
  pages: PageSummary[];
  objectsData: DetectionResponse;
  currentPageIndex: number;
  onSelectPage: (index: number) => void;
}

function getPageReviewStatus(
  page: PageSummary,
  objectsData: DetectionResponse
): "not_started" | "in_progress" | "complete" {
  const pageObjs = objectsData.pages.find(
    (p) => p.page_number === page.page_number
  );
  if (!pageObjs || pageObjs.objects.length === 0) return "not_started";
  const total = pageObjs.objects.length;
  const reviewed = pageObjs.objects.filter(
    (o) => o.status !== "unreviewed"
  ).length;
  if (reviewed === 0) return "not_started";
  if (reviewed === total) return "complete";
  return "in_progress";
}

function getPageConfidence(
  page: PageSummary,
  objectsData: DetectionResponse
): "high" | "low" | "none" {
  const pageObjs = objectsData.pages.find(
    (p) => p.page_number === page.page_number
  );
  if (!pageObjs || pageObjs.objects.length === 0) return "none";
  const hasLow = pageObjs.objects.some(
    (o) => o.confidence != null && o.confidence < 0.5
  );
  return hasLow ? "low" : "high";
}

const STATUS_INDICATORS: Record<string, { symbol: string; color: string }> = {
  not_started: { symbol: "\u25CB", color: "#64748b" }, // ○
  in_progress: { symbol: "\u25D0", color: "#f59e0b" }, // ◐
  complete: { symbol: "\u2713", color: "#22c55e" }, // ✓
};

export function PageList({
  pages,
  objectsData,
  currentPageIndex,
  onSelectPage,
}: Props) {
  return (
    <div style={{ padding: 4 }}>
      {pages.map((page, index) => {
        const isCurrent = index === currentPageIndex;
        const reviewStatus = getPageReviewStatus(page, objectsData);
        const confidence = getPageConfidence(page, objectsData);
        const indicator = STATUS_INDICATORS[reviewStatus];

        const borderColor =
          confidence === "low"
            ? "#f59e0b"
            : reviewStatus === "complete"
              ? "#22c55e"
              : isCurrent
                ? "#3b82f6"
                : "#334155";

        return (
          <div
            key={page.id}
            onClick={() => onSelectPage(index)}
            style={{
              cursor: "pointer",
              marginBottom: 4,
              borderRadius: 4,
              border: `2px solid ${borderColor}`,
              background: isCurrent ? "#1e293b" : "transparent",
              overflow: "hidden",
            }}
          >
            {page.thumb_url && (
              <img
                src={thumbUrl(page.thumb_url)}
                alt={`Page ${page.page_number + 1}`}
                style={{ width: "100%", display: "block" }}
              />
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "3px 6px",
                fontSize: 11,
              }}
            >
              <span style={{ color: isCurrent ? "#e2e8f0" : "#94a3b8" }}>
                {page.page_number + 1}
              </span>
              <span style={{ color: indicator.color }}>{indicator.symbol}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
