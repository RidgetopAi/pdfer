import { useQuery } from "@tanstack/react-query";
import { fetchModelStatus } from "../../api/client";
import type { ModelStatus as ModelStatusData } from "../../api/client";
import styles from "./ModelStatus.module.css";

/**
 * Footer indicator showing which GPU model is currently resident.
 *
 * Polls every 2s while ANY model is loaded (so VRAM number stays live during
 * inference), every 8s otherwise. The label is the source of truth users
 * normally check via btop — surfacing it here so they don't have to alt-tab.
 */
export function ModelStatus() {
  const q = useQuery({
    queryKey: ["modelStatus"],
    queryFn: fetchModelStatus,
    refetchInterval: (query) => {
      const data = query.state.data as ModelStatusData | undefined;
      if (!data) return 4000;
      return data.active ? 2000 : 8000;
    },
    staleTime: 1000,
  });

  if (q.isLoading && !q.data) {
    return <Indicator label="MODEL" body={<span className={styles.dim}>…</span>} />;
  }
  if (q.error) {
    return (
      <Indicator
        label="MODEL"
        body={<span className={styles.errText}>unreachable</span>}
        title={(q.error as Error).message}
      />
    );
  }
  const data = q.data!;
  const activeText = data.active ? data.active.toUpperCase() : "idle";
  const dotClass = data.active === "yolo"
    ? styles.dotYolo
    : data.active === "gemma"
    ? styles.dotGemma
    : styles.dotIdle;
  const vramText =
    data.vram_mib != null && data.vram_mib > 1
      ? `${Math.round(data.vram_mib)} MiB`
      : null;

  return (
    <Indicator
      label="MODEL"
      title={`yolo: ${data.yolo} · gemma: ${data.gemma}`}
      body={
        <span className={styles.body}>
          <span className={`${styles.dot} ${dotClass}`} />
          <span className={data.active ? styles.active : styles.idle}>{activeText}</span>
          {vramText && <span className={styles.vram}>{vramText}</span>}
        </span>
      }
    />
  );
}

function Indicator({
  label,
  body,
  title,
}: {
  label: string;
  body: React.ReactNode;
  title?: string;
}) {
  return (
    <div className={styles.indicator} title={title}>
      <span className={styles.label}>{label}</span>
      {body}
    </div>
  );
}
