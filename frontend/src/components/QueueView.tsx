import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  fetchQueue,
  submitEdits,
  type EditAction,
} from "../api/client";

const LABEL_COLORS: Record<string, string> = {
  title: "#f59e0b",
  section_heading: "#f97316",
  paragraph: "#3b82f6",
  table: "#10b981",
  figure: "#8b5cf6",
  caption: "#ec4899",
  footnote: "#6366f1",
  list: "#14b8a6",
  formula: "#f43e5e",
  page_header: "#64748b",
  page_footer: "#64748b",
  watermark: "#475569",
};

interface Props {
  documentId: string;
  onClose: () => void;
  onNavigateToObject?: (pageNumber: number, objectId: string) => void;
}

export function QueueView({ documentId, onClose, onNavigateToObject }: Props) {
  const [sortBy, setSortBy] = useState<string>("confidence");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { data, refetch } = useQuery({
    queryKey: ["queue", documentId, sortBy, statusFilter],
    queryFn: () => fetchQueue(documentId, sortBy, statusFilter),
  });

  const editMutation = useMutation({
    mutationFn: (edits: EditAction[]) => submitEdits(documentId, edits),
    onSuccess: () => refetch(),
  });

  const objects = data?.objects ?? [];

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= objects.length && objects.length > 0) {
      setSelectedIndex(objects.length - 1);
    }
  }, [objects.length, selectedIndex]);

  const confirmSelected = useCallback(() => {
    if (objects.length === 0) return;
    const obj = objects[selectedIndex];
    if (obj) {
      editMutation.mutate([{ action: "confirm", object_id: obj.object_id }]);
    }
  }, [objects, selectedIndex, editMutation]);

  const rejectSelected = useCallback(() => {
    if (objects.length === 0) return;
    const obj = objects[selectedIndex];
    if (obj) {
      editMutation.mutate([{ action: "reject", object_id: obj.object_id }]);
    }
  }, [objects, selectedIndex, editMutation]);

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, objects.length - 1));
        return;
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "c") {
        e.preventDefault();
        confirmSelected();
        return;
      }
      if (e.key === "x") {
        e.preventDefault();
        rejectSelected();
        return;
      }
      if (e.key === "g" && onNavigateToObject && objects[selectedIndex]) {
        const obj = objects[selectedIndex];
        onNavigateToObject(obj.page_number, obj.object_id);
        return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [objects, selectedIndex, onClose, confirmSelected, rejectSelected, onNavigateToObject]);

  const confColor = (c: number | null) => {
    if (c === null) return "#64748b";
    if (c >= 0.9) return "#22c55e";
    if (c >= 0.7) return "#f59e0b";
    if (c >= 0.5) return "#f97316";
    return "#ef4444";
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#0f172a",
        color: "#e2e8f0",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid #1e293b",
        }}
      >
        <strong style={{ fontSize: 14 }}>Queue View</strong>
        <span style={{ fontSize: 12, color: "#64748b" }}>
          {objects.length} objects
        </span>
        <div style={{ flex: 1 }} />

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setSelectedIndex(0); }}
          style={{
            background: "#1e293b",
            border: "1px solid #475569",
            color: "#e2e8f0",
            padding: "3px 8px",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <option value="all">All statuses</option>
          <option value="unreviewed">Unreviewed only</option>
          <option value="confirmed">Confirmed only</option>
          <option value="low_confidence">Low confidence (&lt;0.5)</option>
        </select>

        <select
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value); setSelectedIndex(0); }}
          style={{
            background: "#1e293b",
            border: "1px solid #475569",
            color: "#e2e8f0",
            padding: "3px 8px",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          <option value="confidence">Sort: Confidence (low first)</option>
          <option value="page">Sort: Page number</option>
        </select>

        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "1px solid #475569",
            color: "#94a3b8",
            padding: "3px 10px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Close (Esc)
        </button>
      </div>

      {/* Object list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0" }}>
        {objects.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
            No objects match the current filter.
          </div>
        )}
        {objects.map((obj, i) => (
          <div
            key={obj.object_id}
            onClick={() => setSelectedIndex(i)}
            onDoubleClick={() => {
              if (onNavigateToObject) onNavigateToObject(obj.page_number, obj.object_id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 16px",
              borderBottom: "1px solid #1e293b",
              background: i === selectedIndex ? "#1e293b" : "transparent",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {/* Page number */}
            <span
              style={{
                width: 32,
                textAlign: "center",
                fontSize: 11,
                color: "#64748b",
                flexShrink: 0,
              }}
            >
              p{obj.page_number}
            </span>

            {/* Label badge */}
            <span
              style={{
                display: "inline-block",
                padding: "1px 6px",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 600,
                background: LABEL_COLORS[obj.label] || "#475569",
                color: "#fff",
                minWidth: 80,
                textAlign: "center",
                flexShrink: 0,
              }}
            >
              {obj.label}
            </span>

            {/* Confidence */}
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: confColor(obj.confidence),
                minWidth: 40,
                textAlign: "right",
                flexShrink: 0,
              }}
            >
              {obj.confidence !== null ? `${(obj.confidence * 100).toFixed(0)}%` : "—"}
            </span>

            {/* Status */}
            <span
              style={{
                fontSize: 11,
                color:
                  obj.status === "confirmed"
                    ? "#22c55e"
                    : obj.status === "rejected"
                      ? "#ef4444"
                      : "#94a3b8",
                minWidth: 70,
                flexShrink: 0,
              }}
            >
              {obj.status}
            </span>

            {/* Extraction status */}
            <span
              style={{
                fontSize: 11,
                color:
                  obj.extraction_status === "extracted"
                    ? "#22c55e"
                    : obj.extraction_status === "placeholder"
                      ? "#f59e0b"
                      : "#475569",
                flexShrink: 0,
              }}
            >
              {obj.extraction_status === "extracted"
                ? "extracted"
                : obj.extraction_status === "placeholder"
                  ? "FAILED"
                  : "—"}
            </span>

            <div style={{ flex: 1 }} />

            {/* Quick action buttons (only for unreviewed) */}
            {obj.status === "unreviewed" && i === selectedIndex && (
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    editMutation.mutate([{ action: "confirm", object_id: obj.object_id }]);
                  }}
                  style={{
                    background: "#166534",
                    border: "none",
                    color: "#e2e8f0",
                    padding: "2px 8px",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  Confirm (Enter)
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    editMutation.mutate([{ action: "reject", object_id: obj.object_id }]);
                  }}
                  style={{
                    background: "#7f1d1d",
                    border: "none",
                    color: "#e2e8f0",
                    padding: "2px 8px",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  Reject (X)
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Status bar */}
      <div
        style={{
          padding: "6px 16px",
          borderTop: "1px solid #1e293b",
          fontSize: 12,
          color: "#64748b",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>
          {selectedIndex + 1}/{objects.length} selected
        </span>
        <span>
          j/k: navigate | Enter: confirm | X: reject | G: go to canvas | Esc: close
        </span>
      </div>
    </div>
  );
}
