import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UploadForm } from "./components/UploadForm";
import { DocumentList } from "./components/DocumentList";
import { DocumentDetail } from "./components/DocumentDetail";
import { Workspace } from "./components/Workspace";
import type { DocumentSummary } from "./api/client";

const queryClient = new QueryClient();

function AppInner() {
  const [selectedDoc, setSelectedDoc] = useState<DocumentSummary | null>(null);

  if (selectedDoc) {
    // Stage >= 1 (detection complete) → Review Workspace
    if (selectedDoc.current_stage >= 1) {
      return (
        <Workspace
          documentId={selectedDoc.id}
          onBack={() => setSelectedDoc(null)}
        />
      );
    }
    // Stage 0 → Simple detail view (upload/ingest/detect)
    return (
      <div style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#e2e8f0",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}>
        <header style={{
          borderBottom: "1px solid #1e293b",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>PDFer</h1>
          <span style={{ color: "#64748b", fontSize: 13 }}>PDF to Markdown Pipeline</span>
        </header>
        <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
          <DocumentDetail
            documentId={selectedDoc.id}
            onBack={() => setSelectedDoc(null)}
          />
        </main>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#020617",
      color: "#e2e8f0",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <header style={{
        borderBottom: "1px solid #1e293b",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>PDFer</h1>
        <span style={{ color: "#64748b", fontSize: 13 }}>PDF to Markdown Pipeline</span>
      </header>
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
        <UploadForm />
        <DocumentList
          onSelect={setSelectedDoc}
          selectedId={null}
        />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  );
}
