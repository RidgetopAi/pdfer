import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import {
  fetchSettings,
  updateSettings,
  SettingsNotImplementedError,
} from "../../api/client";
import { Button, Panel } from "../../design";
import styles from "./Settings.module.css";

export function Settings() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    retry: (count, err) => (err instanceof SettingsNotImplementedError ? false : count < 2),
  });

  // Populate draft once when server returns a value.
  useEffect(() => {
    if (settingsQuery.data && settingsQuery.data.watch_folder != null) {
      setDraft(settingsQuery.data.watch_folder);
    }
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (watchFolder: string) => updateSettings({ watch_folder: watchFolder }),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      setSaveMsg("Saved. Backend will begin watching this folder.");
    },
    onError: (e) => {
      if (e instanceof SettingsNotImplementedError) {
        setSaveMsg(null); // banner handles this state
      } else {
        setSaveMsg(`Failed to save: ${(e as Error).message}`);
      }
    },
  });

  const notImplemented =
    settingsQuery.error instanceof SettingsNotImplementedError ||
    saveMutation.error instanceof SettingsNotImplementedError;
  const loading = settingsQuery.isLoading;
  const genericError: Error | null =
    settingsQuery.error && !(settingsQuery.error instanceof SettingsNotImplementedError)
      ? (settingsQuery.error as Error)
      : null;

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Link to="/v2" className={styles.back}>← DASHBOARD</Link>
      </div>

      <h1 className={styles.title}>Settings</h1>
      <p className={styles.subtitle}>Configure how PDFer discovers documents to process.</p>

      {notImplemented && <PendingBanner />}
      {genericError && !notImplemented && <ErrorBanner message={genericError.message} />}
      {saveMutation.isSuccess && saveMsg && <SuccessBanner message={saveMsg} />}

      <Panel title="Watch Folder">
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="watch">Directory path</label>
          <input
            id="watch"
            className={styles.input}
            type="text"
            placeholder="/absolute/path/to/watch"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={loading || notImplemented}
            spellCheck={false}
            autoComplete="off"
          />
          <div className={styles.fieldHint}>
            Absolute path on the backend server. New PDFs dropped into this folder will be
            ingested automatically. The backend polls on an interval.
          </div>
        </div>

        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={loading || notImplemented || saveMutation.isPending || draft.trim() === ""}
            onClick={() => saveMutation.mutate(draft.trim())}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/* --------------------------------------------------------------------
   State banners — explicit about truth. No mock success, no hidden
   "feature pending" dialogs. If the backend route is missing, say so.
-------------------------------------------------------------------- */

function PendingBanner() {
  return (
    <div className={`${styles.banner} ${styles.warn}`}>
      <AlertCircle size={18} className={styles.bannerIcon} />
      <div className={styles.bannerBody}>
        <strong>Backend endpoint pending.</strong> The backend does not yet expose{" "}
        <code>GET/PUT /settings</code>. This page will function once the backend lands its
        settings router (tracked separately). Your input is preserved locally but nothing is
        persisted yet.
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className={`${styles.banner} ${styles.error}`}>
      <AlertCircle size={18} className={styles.bannerIcon} />
      <div className={styles.bannerBody}>
        <strong>Couldn't reach backend.</strong> {message}
      </div>
    </div>
  );
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <div className={`${styles.banner} ${styles.success}`}>
      <CheckCircle2 size={18} className={styles.bannerIcon} />
      <div className={styles.bannerBody}>{message}</div>
    </div>
  );
}

// Reserved for later use (informational messages).
export function _InfoBanner({ message }: { message: string }) {
  return (
    <div className={`${styles.banner} ${styles.info}`}>
      <Info size={18} className={styles.bannerIcon} />
      <div className={styles.bannerBody}>{message}</div>
    </div>
  );
}
