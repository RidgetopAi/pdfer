import { useEffect, useMemo, useState } from "react";
import {
  patchObjectDescription,
  redescribeObject,
  type DetectedObject,
  type EditAction,
  type PageObjects,
  type ReviewStats,
} from "../api/client";

const LABELS = [
  "title",
  "section_heading",
  "paragraph",
  "table",
  "figure",
  "caption",
  "footnote",
  "list",
  "formula",
  "page_header",
  "page_footer",
  "watermark",
] as const;

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

interface Props {
  objects: DetectedObject[];
  onEdit: (edits: EditAction[]) => void;
  autoConfirmThreshold: number;
  onAutoConfirm: (threshold: number) => void;
  stats?: ReviewStats;
  allPageObjects?: PageObjects[];
  onNavigateToObject?: (pageNumber: number, objectId: string) => void;
}

export function ObjectInspector({
  objects,
  onEdit,
  autoConfirmThreshold,
  onAutoConfirm,
  stats,
  allPageObjects,
  onNavigateToObject,
}: Props) {
  const [threshold, setThreshold] = useState(autoConfirmThreshold);

  const unreviewed = useMemo(() => {
    if (!allPageObjects) return [];
    const rows: { pageNumber: number; obj: DetectedObject }[] = [];
    for (const p of allPageObjects) {
      for (const o of p.objects) {
        if (o.status === "unreviewed") {
          rows.push({ pageNumber: p.page_number, obj: o });
        }
      }
    }
    rows.sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
      const ao = a.obj.reading_order ?? 9999;
      const bo = b.obj.reading_order ?? 9999;
      return ao - bo;
    });
    return rows;
  }, [allPageObjects]);

  const unreviewedList = onNavigateToObject && unreviewed.length > 0 && (
    <div
      style={{
        background: "#0f172a",
        borderRadius: 6,
        padding: 10,
        border: "1px solid #1e293b",
        marginTop: 16,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: "#94a3b8",
          marginBottom: 8,
          fontWeight: 600,
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>Unreviewed</span>
        <span style={{ color: "#e2e8f0" }}>{unreviewed.length}</span>
      </div>
      <div
        style={{
          maxHeight: 260,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          margin: "0 -4px",
        }}
      >
        {unreviewed.map(({ pageNumber, obj }) => {
          const color = LABEL_COLORS[obj.label] ?? "#94a3b8";
          const isSelected = objects.some((o) => o.id === obj.id);
          return (
            <button
              key={obj.id}
              onClick={() => onNavigateToObject(pageNumber, obj.id)}
              title={`Page ${pageNumber} — ${obj.label}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                textAlign: "left",
                background: isSelected ? "#1e293b" : "transparent",
                border: "none",
                borderLeft: `3px solid ${color}`,
                color: "#e2e8f0",
                padding: "4px 8px",
                fontSize: 12,
                cursor: "pointer",
                borderRadius: 2,
              }}
              onMouseEnter={(e) => {
                if (!isSelected)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "#111c30";
              }}
              onMouseLeave={(e) => {
                if (!isSelected)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "transparent";
              }}
            >
              <span
                style={{
                  color: "#64748b",
                  fontFamily: "monospace",
                  minWidth: 24,
                }}
              >
                p{pageNumber}
              </span>
              <span style={{ flex: 1 }}>{obj.label.replace(/_/g, " ")}</span>
              {obj.confidence != null && (
                <span
                  style={{
                    color:
                      obj.confidence >= 0.5 ? "#94a3b8" : "#ef4444",
                    fontFamily: "monospace",
                    fontSize: 11,
                  }}
                >
                  {(obj.confidence * 100).toFixed(0)}%
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  // Nothing selected
  if (objects.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 14, color: "#94a3b8" }}>
          Inspector
        </h3>

        <p style={{ fontSize: 13, color: "#64748b", marginBottom: 20 }}>
          Click an object on the canvas to inspect and edit it.
        </p>

        {/* Auto-confirm control */}
        <div
          style={{
            background: "#0f172a",
            borderRadius: 6,
            padding: 12,
            border: "1px solid #1e293b",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#94a3b8",
              marginBottom: 8,
              fontWeight: 600,
            }}
          >
            Auto-Confirm Threshold
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              min={0.5}
              max={1.0}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(parseFloat(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: 13, color: "#e2e8f0", minWidth: 40 }}>
              {(threshold * 100).toFixed(0)}%
            </span>
          </div>
          <button
            onClick={() => onAutoConfirm(threshold)}
            style={{
              marginTop: 8,
              width: "100%",
              background: "#166534",
              border: "none",
              color: "#e2e8f0",
              padding: "6px 12px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Auto-Confirm Above {(threshold * 100).toFixed(0)}%
          </button>
        </div>

        {/* Stats */}
        {stats && (
          <div
            style={{
              background: "#0f172a",
              borderRadius: 6,
              padding: 12,
              border: "1px solid #1e293b",
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "#94a3b8",
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              Review Progress
            </div>
            <div style={{ fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#22c55e" }}>Confirmed</span>
                <span style={{ color: "#e2e8f0" }}>{stats.confirmed}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#ef4444" }}>Rejected</span>
                <span style={{ color: "#e2e8f0" }}>{stats.rejected}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#94a3b8" }}>Unreviewed</span>
                <span style={{ color: "#e2e8f0" }}>{stats.unreviewed}</span>
              </div>
              {/* Progress bar */}
              <div
                style={{
                  height: 4,
                  background: "#334155",
                  borderRadius: 2,
                  marginTop: 8,
                  overflow: "hidden",
                  display: "flex",
                }}
              >
                {stats.total_objects > 0 && (
                  <>
                    <div
                      style={{
                        width: `${(stats.confirmed / stats.total_objects) * 100}%`,
                        background: "#22c55e",
                      }}
                    />
                    <div
                      style={{
                        width: `${(stats.rejected / stats.total_objects) * 100}%`,
                        background: "#ef4444",
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {unreviewedList}

        {/* Keyboard shortcut reference */}
        <div style={{ marginTop: 16, fontSize: 11, color: "#475569" }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: "#64748b" }}>
            Shortcuts
          </div>
          <div>Tab — cycle objects</div>
          <div>Enter/C — confirm</div>
          <div>X — reject</div>
          <div>D — draw mode</div>
          <div>Del — delete</div>
          <div>F1-F9 — relabel</div>
          <div>Ctrl+Z — undo</div>
          <div>Ctrl+Shift+Z — redo</div>
          <div>DblClick — confirm</div>
        </div>
      </div>
    );
  }

  // Single selection
  if (objects.length === 1) {
    const obj = objects[0];
    const color = LABEL_COLORS[obj.label] ?? "#94a3b8";
    const w = Math.round(obj.bbox_x2 - obj.bbox_x1);
    const h = Math.round(obj.bbox_y2 - obj.bbox_y1);

    return (
      <div style={{ padding: 16 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#94a3b8" }}>
          Object Inspector
        </h3>

        {/* Label with color indicator */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              background: color,
            }}
          />
          <span style={{ fontSize: 16, fontWeight: 600 }}>
            {obj.label.replace(/_/g, " ")}
          </span>
        </div>

        {/* Status */}
        <div style={{ marginBottom: 12 }}>
          <span
            style={{
              fontSize: 12,
              padding: "2px 8px",
              borderRadius: 3,
              background:
                obj.status === "confirmed"
                  ? "#166534"
                  : obj.status === "rejected"
                    ? "#7f1d1d"
                    : "#1e293b",
              color: "#e2e8f0",
            }}
          >
            {obj.status}
          </span>
          {obj.confidence != null && (
            <span
              style={{
                marginLeft: 8,
                fontSize: 12,
                color:
                  obj.confidence >= 0.8
                    ? "#22c55e"
                    : obj.confidence >= 0.5
                      ? "#f59e0b"
                      : "#ef4444",
              }}
            >
              {(obj.confidence * 100).toFixed(1)}% confidence
            </span>
          )}
        </div>

        {/* Relabel dropdown */}
        <div style={{ marginBottom: 12 }}>
          <label
            style={{
              fontSize: 11,
              color: "#94a3b8",
              display: "block",
              marginBottom: 4,
            }}
          >
            Label
          </label>
          <select
            value={obj.label}
            onChange={(e) =>
              onEdit([
                { action: "relabel", object_id: obj.id, label: e.target.value },
              ])
            }
            style={{
              width: "100%",
              background: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 4,
              padding: "4px 8px",
              fontSize: 13,
            }}
          >
            {LABELS.map((l) => (
              <option key={l} value={l}>
                {l.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>

        {/* Heading level (for title/section_heading) */}
        {(obj.label === "title" || obj.label === "section_heading") && (
          <div style={{ marginBottom: 12 }}>
            <label
              style={{
                fontSize: 11,
                color: "#94a3b8",
                display: "block",
                marginBottom: 4,
              }}
            >
              Heading Level
            </label>
            <select
              value={obj.heading_level ?? ""}
              onChange={(e) =>
                onEdit([
                  {
                    action: "set_heading_level",
                    object_id: obj.id,
                    heading_level: parseInt(e.target.value),
                  },
                ])
              }
              style={{
                width: "100%",
                background: "#0f172a",
                color: "#e2e8f0",
                border: "1px solid #334155",
                borderRadius: 4,
                padding: "4px 8px",
                fontSize: 13,
              }}
            >
              {[1, 2, 3, 4, 5, 6].map((l) => (
                <option key={l} value={l}>
                  H{l}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Bbox info */}
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
          {w} x {h} px | pos ({Math.round(obj.bbox_x1)}, {Math.round(obj.bbox_y1)})
        </div>

        {/* Source */}
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 16 }}>
          Source: {obj.source} | Order: {obj.reading_order ?? "—"}
        </div>

        {/* AI read — Gemma's description, editable by the user */}
        <DescriptionEditor key={obj.id} obj={obj} />

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 6 }}>
          {obj.status !== "confirmed" && (
            <button
              onClick={() =>
                onEdit([{ action: "confirm", object_id: obj.id }])
              }
              style={{
                flex: 1,
                background: "#166534",
                border: "none",
                color: "#e2e8f0",
                padding: "6px 0",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Confirm (C)
            </button>
          )}
          {obj.status !== "rejected" && (
            <button
              onClick={() => onEdit([{ action: "reject", object_id: obj.id }])}
              style={{
                flex: 1,
                background: "#7f1d1d",
                border: "none",
                color: "#e2e8f0",
                padding: "6px 0",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Reject (X)
            </button>
          )}
          <button
            onClick={() => onEdit([{ action: "delete", object_id: obj.id }])}
            style={{
              background: "#1e293b",
              border: "1px solid #475569",
              color: "#94a3b8",
              padding: "6px 10px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Del
          </button>
        </div>

        {unreviewedList}
      </div>
    );
  }

  // Multi-selection
  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#94a3b8" }}>
        {objects.length} Objects Selected
      </h3>

      {/* Label breakdown */}
      <div style={{ marginBottom: 16 }}>
        {Object.entries(
          objects.reduce(
            (acc, o) => {
              acc[o.label] = (acc[o.label] ?? 0) + 1;
              return acc;
            },
            {} as Record<string, number>
          )
        ).map(([label, count]) => (
          <div
            key={label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 13,
              marginBottom: 4,
            }}
          >
            <span style={{ color: LABEL_COLORS[label] ?? "#94a3b8" }}>
              {label.replace(/_/g, " ")}
            </span>
            <span style={{ color: "#e2e8f0" }}>{count}</span>
          </div>
        ))}
      </div>

      {/* Batch actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          onClick={() =>
            onEdit(objects.map((o) => ({ action: "confirm", object_id: o.id })))
          }
          style={{
            background: "#166534",
            border: "none",
            color: "#e2e8f0",
            padding: "8px 12px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Confirm All ({objects.length})
        </button>
        <button
          onClick={() =>
            onEdit(objects.map((o) => ({ action: "reject", object_id: o.id })))
          }
          style={{
            background: "#7f1d1d",
            border: "none",
            color: "#e2e8f0",
            padding: "8px 12px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Reject All ({objects.length})
        </button>

        {/* Batch relabel */}
        <select
          defaultValue=""
          onChange={(e) => {
            if (!e.target.value) return;
            onEdit(
              objects.map((o) => ({
                action: "relabel",
                object_id: o.id,
                label: e.target.value,
              }))
            );
            e.target.value = "";
          }}
          style={{
            background: "#0f172a",
            color: "#e2e8f0",
            border: "1px solid #334155",
            borderRadius: 4,
            padding: "6px 8px",
            fontSize: 12,
          }}
        >
          <option value="">Relabel all to...</option>
          {LABELS.map((l) => (
            <option key={l} value={l}>
              {l.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {unreviewedList}
    </div>
  );
}


interface DescriptionEditorProps {
  obj: DetectedObject;
}

function DescriptionEditor({ obj }: DescriptionEditorProps) {
  const [text, setText] = useState(obj.description ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(obj.description_status ?? "pending");
  const [edited, setEdited] = useState(
    (obj.description_edited_by_user ?? 0) === 1,
  );

  // Reset when the selected object changes
  useEffect(() => {
    setText(obj.description ?? "");
    setDirty(false);
    setError(null);
    setStatus(obj.description_status ?? "pending");
    setEdited((obj.description_edited_by_user ?? 0) === 1);
  }, [obj.id, obj.description, obj.description_status, obj.description_edited_by_user]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await patchObjectDescription(obj.id, text);
      setDirty(false);
      setSavedAt(Date.now());
      setEdited(res.description_edited_by_user === 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const redescribe = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await redescribeObject(obj.id, true);
      setText(res.description ?? "");
      setDirty(false);
      setEdited(false);
      setStatus("described");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const statusColor =
    status === "described"
      ? "#4ade80"
      : status === "failed"
        ? "#ef4444"
        : status === "skipped"
          ? "#94a3b8"
          : "#f59e0b";

  return (
    <div
      style={{
        background: "#0f172a",
        borderRadius: 6,
        padding: 12,
        border: "1px solid #1e293b",
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600 }}>
          AI read{obj.description_model ? ` (${obj.description_model})` : ""}
        </span>
        <span style={{ fontSize: 10, color: statusColor, fontFamily: "monospace" }}>
          {status}
          {edited && <span style={{ color: "#a78bfa", marginLeft: 6 }}>edited</span>}
        </span>
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        placeholder={
          status === "pending"
            ? "Not yet described — run Describe from the top bar."
            : "No description available."
        }
        rows={6}
        style={{
          width: "100%",
          background: "#020617",
          color: "#e2e8f0",
          border: "1px solid #334155",
          borderRadius: 4,
          padding: 8,
          fontSize: 12,
          fontFamily: "monospace",
          lineHeight: 1.5,
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button
          onClick={save}
          disabled={!dirty || saving}
          style={{
            flex: 1,
            background: dirty ? "#1e40af" : "#1e293b",
            border: "1px solid " + (dirty ? "#3b82f6" : "#475569"),
            color: dirty ? "#e2e8f0" : "#64748b",
            padding: "5px 0",
            borderRadius: 4,
            cursor: dirty && !saving ? "pointer" : "not-allowed",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {saving ? "Saving..." : savedAt && !dirty ? "Saved" : "Save correction"}
        </button>
        <button
          onClick={redescribe}
          disabled={saving}
          title="Re-run Gemma on this object"
          style={{
            background: "#1e293b",
            border: "1px solid #475569",
            color: "#cbd5e1",
            padding: "5px 10px",
            borderRadius: 4,
            cursor: saving ? "not-allowed" : "pointer",
            fontSize: 11,
          }}
        >
          Redescribe
        </button>
      </div>

      {error && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#ef4444" }}>
          {error}
        </div>
      )}
      {dirty && (
        <div style={{ marginTop: 6, fontSize: 10, color: "#a78bfa" }}>
          Saving captures a training tuple (Gemma's output + your correction).
        </div>
      )}
    </div>
  );
}
