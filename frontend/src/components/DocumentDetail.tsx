import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchDocument,
  fetchObjects,
  detectDocument,
  thumbUrl,
  pageImageUrl,
} from "../api/client";
import { PageCanvas } from "./PageCanvas";

interface Props {
  documentId: string;
  onBack: () => void;
}

const PDF_TYPE_COLORS: Record<string, string> = {
  "born-digital-clean": "#22c55e",
  "born-digital-corrupt": "#f59e0b",
  "scanned-with-ocr": "#3b82f6",
  "scanned-no-ocr": "#ef4444",
};

const CANVAS_DISPLAY_WIDTH = 500;

export function DocumentDetail({ documentId, onBack }: Props) {
  const queryClient = useQueryClient();
  const [showOverlays, setShowOverlays] = useState(true);

  const { data: doc, isLoading, error } = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => fetchDocument(documentId),
  });

  const { data: detectionData } = useQuery({
    queryKey: ["objects", documentId],
    queryFn: () => fetchObjects(documentId),
    enabled: !!doc && doc.current_stage >= 1,
  });

  const detectMutation = useMutation({
    mutationFn: () => detectDocument(documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document", documentId] });
      queryClient.invalidateQueries({ queryKey: ["objects", documentId] });
    },
  });

  if (isLoading) return <p style={{ color: "#94a3b8" }}>Loading...</p>;
  if (error || !doc) return <p style={{ color: "#ef4444" }}>Failed to load document</p>;

  const hasDetections = doc.current_stage >= 1 && detectionData != null && detectionData.total_objects > 0;
  const canDetect = doc.current_stage === 0 && doc.stage_status === "complete";

  // Build a map from page_number → objects for this page
  const pageObjectsMap = new Map<number, NonNullable<typeof detectionData>["pages"][number]>();
  if (detectionData) {
    for (const p of detectionData.pages) {
      pageObjectsMap.set(p.page_number, p);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "1px solid #475569",
            color: "#94a3b8",
            padding: "6px 14px",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Back to list
        </button>

        {canDetect && (
          <button
            onClick={() => detectMutation.mutate()}
            disabled={detectMutation.isPending}
            style={{
              background: detectMutation.isPending ? "#475569" : "#3b82f6",
              border: "none",
              color: "#fff",
              padding: "6px 16px",
              borderRadius: 6,
              cursor: detectMutation.isPending ? "default" : "pointer",
              fontWeight: 600,
            }}
          >
            {detectMutation.isPending ? "Detecting..." : "Detect Layout"}
          </button>
        )}

        {hasDetections && (
          <>
            <span style={{ color: "#22c55e", fontSize: 13 }}>
              {detectionData.total_objects} objects detected
            </span>
            <button
              onClick={() => setShowOverlays(!showOverlays)}
              style={{
                background: showOverlays ? "#1e293b" : "none",
                border: "1px solid #475569",
                color: showOverlays ? "#e2e8f0" : "#94a3b8",
                padding: "4px 12px",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {showOverlays ? "Hide boxes" : "Show boxes"}
            </button>
          </>
        )}
      </div>

      {detectMutation.isError && (
        <p style={{ color: "#ef4444", marginBottom: 12 }}>
          Detection failed: {String(detectMutation.error)}
        </p>
      )}

      <h2 style={{ color: "#e2e8f0", margin: "0 0 8px" }}>{doc.filename}</h2>
      <div style={{ color: "#94a3b8", fontSize: 14, marginBottom: 20 }}>
        {doc.page_count} pages | Stage {doc.current_stage} ({doc.stage_status})
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: hasDetections && showOverlays
          ? "repeat(auto-fill, minmax(520px, 1fr))"
          : "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 16,
      }}>
        {doc.pages.map((page) => {
          const pageObjs = pageObjectsMap.get(page.page_number);
          const objects = pageObjs?.objects ?? [];
          const showCanvas = hasDetections && showOverlays && objects.length > 0;

          return (
            <div
              key={page.id}
              style={{
                background: "#1e293b",
                borderRadius: 8,
                overflow: "hidden",
                border: "1px solid #334155",
              }}
            >
              {showCanvas ? (
                <PageCanvas
                  imageUrl={pageImageUrl(documentId, page.page_number)}
                  objects={objects}
                  originalWidth={page.width_px}
                  originalHeight={page.height_px}
                  displayWidth={CANVAS_DISPLAY_WIDTH}
                />
              ) : (
                page.thumb_url && (
                  <img
                    src={thumbUrl(page.thumb_url)}
                    alt={`Page ${page.page_number}`}
                    style={{ width: "100%", display: "block" }}
                  />
                )
              )}
              <div style={{ padding: "10px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "#e2e8f0", fontWeight: 600 }}>Page {page.page_number + 1}</span>
                  {objects.length > 0 && (
                    <span style={{ fontSize: 12, color: "#94a3b8" }}>
                      {objects.length} objects
                    </span>
                  )}
                  <span style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 3,
                    background: "#0f172a",
                    color: PDF_TYPE_COLORS[page.pdf_type ?? ""] ?? "#94a3b8",
                    border: `1px solid ${PDF_TYPE_COLORS[page.pdf_type ?? ""] ?? "#475569"}`,
                  }}>
                    {page.pdf_type?.replace(/-/g, " ") ?? "unknown"}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 6 }}>
                  {page.width_px} x {page.height_px}px | {page.text_span_count} text spans
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
