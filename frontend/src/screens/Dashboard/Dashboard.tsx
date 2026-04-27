import { useQuery, useQueries } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { fetchDocuments, fetchReviewStats } from "../../api/client";
import type { DocumentSummary, ReviewStats } from "../../api/client";
import { Button } from "../../design";
import { FileRow } from "./FileRow";
import { STAGE_LABELS } from "./stageMapping";
import { Upload } from "./Upload";
import { ModelStatus } from "./ModelStatus";
import { CorpusStatus } from "./CorpusStatus";
import styles from "./Dashboard.module.css";

export function Dashboard() {
  // Adaptive polling: tight (1.5s) while any doc is processing for live
  // matrix glow; lazy (8s) otherwise. Per-doc WebSockets open only in Review.
  const docsQuery = useQuery({
    queryKey: ["documents"],
    queryFn: fetchDocuments,
    refetchInterval: (query) => {
      const data = query.state.data as DocumentSummary[] | undefined;
      if (!data) return 5000;
      return data.some((d) => d.stage_status === "running") ? 1500 : 8000;
    },
  });

  const docs: DocumentSummary[] = docsQuery.data ?? [];


  // Per-doc review stats — parallel queries, paused for docs not yet detected.
  const statsQueries = useQueries({
    queries: docs.map((d) => ({
      queryKey: ["reviewStats", d.id],
      queryFn: () => fetchReviewStats(d.id),
      enabled: d.current_stage >= 1,
      staleTime: 10_000,
    })),
  });

  const statsById = new Map<string, ReviewStats>();
  docs.forEach((d, i) => {
    const data = statsQueries[i]?.data;
    if (data) statsById.set(d.id, data);
  });

  return (
    <div className={styles.page}>
      <div className={styles.brand}>
        <span className={styles.dot} />
        PDFer
      </div>

      <Upload />

      <div className={styles.headers}>
        <h2>File Name</h2>
        <h2>Pages</h2>
        <div className={styles.stageLabels}>
          {STAGE_LABELS.map((l) => <span key={l}>{l}</span>)}
        </div>
      </div>

      <DashboardBody
        loading={docsQuery.isLoading}
        error={docsQuery.error}
        docs={docs}
        statsById={statsById}
        onRetry={() => docsQuery.refetch()}
      />

      <div className={styles.footer}>
        <div className={styles.footerLeft}>
          <WatchDirIndicator />
          <ModelStatus />
          <CorpusStatus />
        </div>
        <Link to="/v2/settings">Settings →</Link>
      </div>
    </div>
  );
}

function DashboardBody({
  loading,
  error,
  docs,
  statsById,
  onRetry,
}: {
  loading: boolean;
  error: unknown;
  docs: DocumentSummary[];
  statsById: Map<string, ReviewStats>;
  onRetry: () => void;
}) {
  if (loading && docs.length === 0) {
    return (
      <div className={styles.skeleton}>
        {[0, 1, 2, 3].map((i) => <div key={i} className={styles.skelRow} />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className={`${styles.state} ${styles.error}`}>
        <h3>Can't reach the backend</h3>
        <p>
          The API at <code>http://localhost:8000</code> didn't respond.
          <br />
          {(error as Error).message}
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <Button variant="primary" onClick={onRetry}>Retry</Button>
        </div>
      </div>
    );
  }
  if (docs.length === 0) {
    return (
      <div className={styles.state}>
        <h3>No documents yet</h3>
        <p>
          Use the upload area above to load a PDF, or configure a watch folder in Settings
          for batch ingest.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <Link to="/v2/settings" style={{ textDecoration: "none" }}>
            <Button variant="ghost">Open Settings</Button>
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.list}>
      {docs.map((doc) => (
        <FileRow key={doc.id} doc={doc} review={statsById.get(doc.id)} />
      ))}
    </div>
  );
}

/**
 * Shows the configured watch folder (or an "unset" notice). Phase 4 wires
 * this to a real GET /settings endpoint; for now it's a stub that displays
 * a clear "not configured" state so we never lie about status.
 */
function WatchDirIndicator() {
  // Phase 4 replaces this with useQuery(['settings']).
  // For now: no mock path. Show truth: unset → Settings.
  return (
    <div className={styles.watchDir}>
      <span className={styles.label}>WATCH</span>
      <span style={{ color: "rgb(255, 180, 120)" }}>not configured</span>
    </div>
  );
}
