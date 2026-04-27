import { useQuery } from "@tanstack/react-query";
import { fetchTrainingExportStats } from "../../api/client";
import styles from "./ModelStatus.module.css";

/**
 * Footer indicator showing the size of the YOLO fine-tune corpus.
 *
 * The corpus is derived live from `objects` filtered to confirmed/manual
 * regions on fully-reviewed pages. Numbers move every time the user finishes
 * reviewing a page. We poll lazily — corpus growth is seconds-scale at
 * fastest, not subseconds.
 */
export function CorpusStatus() {
  const q = useQuery({
    queryKey: ["trainingStats"],
    queryFn: fetchTrainingExportStats,
    refetchInterval: 15000,
    staleTime: 5000,
  });

  if (q.isLoading && !q.data) {
    return <Wrap label="CORPUS" body={<span className={styles.dim}>…</span>} />;
  }
  if (q.error) {
    return (
      <Wrap
        label="CORPUS"
        body={<span className={styles.errText}>unreachable</span>}
        title={(q.error as Error).message}
      />
    );
  }
  const data = q.data!;
  const tip =
    `${data.pages_complete} fully-reviewed pages · ${data.exportable_boxes} boxes\n` +
    `${data.manual_boxes_total} manual + ${data.confirmed_boxes_total} confirmed (across all pages)\n` +
    Object.entries(data.per_class)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

  return (
    <Wrap
      label="CORPUS"
      title={tip}
      body={
        <span className={styles.body}>
          <span className={`${styles.dot} ${data.exportable_boxes > 0 ? styles.dotYolo : styles.dotIdle}`} />
          <span className={data.exportable_boxes > 0 ? styles.active : styles.idle}>
            {data.exportable_boxes} BOX
          </span>
          <span className={styles.vram}>{data.pages_complete} pg</span>
        </span>
      }
    />
  );
}

function Wrap({
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
