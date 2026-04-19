import { useQuery } from "@tanstack/react-query";
import { fetchDocuments, type DocumentSummary } from "../api/client";

interface Props {
  onSelect: (doc: DocumentSummary) => void;
  selectedId: string | null;
}

export function DocumentList({ onSelect, selectedId }: Props) {
  const { data: documents, isLoading } = useQuery({
    queryKey: ["documents"],
    queryFn: fetchDocuments,
    refetchInterval: 5000,
  });

  if (isLoading) return <p style={{ color: "#94a3b8" }}>Loading documents...</p>;
  if (!documents?.length) return <p style={{ color: "#64748b" }}>No documents yet. Upload a PDF to get started.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {documents.map((doc) => (
        <div
          key={doc.id}
          onClick={() => onSelect(doc)}
          style={{
            padding: "12px 16px",
            background: selectedId === doc.id ? "#1e293b" : "#0f172a",
            border: `1px solid ${selectedId === doc.id ? "#3b82f6" : "#334155"}`,
            borderRadius: 8,
            cursor: "pointer",
            transition: "all 0.1s",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ color: "#e2e8f0" }}>{doc.filename}</strong>
            <span style={{
              fontSize: 12,
              padding: "2px 8px",
              borderRadius: 4,
              background: doc.stage_status === "complete" ? "#166534" : "#854d0e",
              color: "#e2e8f0",
            }}>
              Stage {doc.current_stage} — {doc.stage_status}
            </span>
          </div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
            {doc.page_count} pages
          </div>
        </div>
      ))}
    </div>
  );
}
