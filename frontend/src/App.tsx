import { useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UploadForm } from "./components/UploadForm";
import { DocumentList } from "./components/DocumentList";
import { DocumentDetail } from "./components/DocumentDetail";
import { Workspace } from "./components/Workspace";
import { Dashboard } from "./screens/Dashboard/Dashboard";
import { Review } from "./screens/Review/Review";
import { Settings } from "./screens/Settings/Settings";
import { NotFound } from "./pages/NotFound";
import type { DocumentSummary } from "./api/client";

const queryClient = new QueryClient();

/* v1 — preserved at /legacy for comparison. Remove after the v2 surface
   bakes in production for a release or two. */
function LegacyApp() {
  const [selectedDoc, setSelectedDoc] = useState<DocumentSummary | null>(null);

  if (selectedDoc) {
    if (selectedDoc.current_stage >= 1) {
      return (
        <Workspace
          documentId={selectedDoc.id}
          onBack={() => setSelectedDoc(null)}
        />
      );
    }
    return (
      <div style={{ minHeight: "100vh", background: "#020617", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <header style={{ borderBottom: "1px solid #1e293b", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>PDFer</h1>
          <span style={{ color: "#64748b", fontSize: 13 }}>(legacy)</span>
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
    <div style={{ minHeight: "100vh", background: "#020617", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <header style={{ borderBottom: "1px solid #1e293b", padding: "16px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>PDFer</h1>
        <span style={{ color: "#64748b", fontSize: 13 }}>(legacy)</span>
        <a href="/" style={{ marginLeft: "auto", color: "#94a3b8", fontSize: 12, textDecoration: "none", padding: "6px 12px", border: "1px solid #334155", borderRadius: 6 }}>
          ← Back to v2
        </a>
      </header>
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>
        <UploadForm />
        <DocumentList onSelect={setSelectedDoc} selectedId={null} />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Root → new dashboard */}
          <Route path="/" element={<Navigate to="/v2" replace />} />

          {/* New v2 surface — primary */}
          <Route path="/v2" element={<Dashboard />} />
          <Route path="/v2/doc/:id" element={<Review />} />
          <Route path="/v2/settings" element={<Settings />} />

          {/* Legacy preserved for comparison */}
          <Route path="/legacy" element={<LegacyApp />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
