import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload as UploadIcon, AlertCircle, CheckCircle2 } from "lucide-react";
import { uploadDocument } from "../../api/client";
import styles from "./Upload.module.css";

export function Upload() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [lastFilename, setLastFilename] = useState<string | null>(null);
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: uploadDocument,
    onSuccess: (doc) => {
      setLastFilename(doc.filename);
      qc.invalidateQueries({ queryKey: ["documents"] });
      if (fileRef.current) fileRef.current.value = "";
    },
  });

  function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const file = files[0];
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      mutation.reset();
      return;
    }
    mutation.mutate(file);
  }

  const busy = mutation.isPending;
  const stateClass = busy
    ? styles.busy
    : dragging
    ? styles.dragging
    : mutation.isError
    ? styles.error
    : "";

  return (
    <div className={styles.wrap}>
      <div
        className={`${styles.drop} ${stateClass}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (busy) return;
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => !busy && fileRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (busy) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,application/pdf"
          onChange={(e) => handleFiles(e.target.files)}
          className={styles.fileInput}
        />
        <div className={styles.icon}>
          <UploadIcon size={20} strokeWidth={1.5} />
        </div>
        <div className={styles.text}>
          <strong className={styles.title}>
            {busy ? "Uploading & ingesting…" : "Drop a PDF here, or click to browse"}
          </strong>
          <span className={styles.hint}>
            Page rendering, layout detection, and review queueing all start automatically.
          </span>
        </div>
      </div>

      {mutation.isSuccess && lastFilename && (
        <div className={`${styles.banner} ${styles.bannerOk}`}>
          <CheckCircle2 size={16} className={styles.bannerIcon} />
          <span>
            <strong>{lastFilename}</strong> uploaded — appears below as it ingests.
          </span>
        </div>
      )}
      {mutation.isError && (
        <div className={`${styles.banner} ${styles.bannerErr}`}>
          <AlertCircle size={16} className={styles.bannerIcon} />
          <span>
            Upload failed: {(mutation.error as Error).message}
          </span>
        </div>
      )}
    </div>
  );
}
