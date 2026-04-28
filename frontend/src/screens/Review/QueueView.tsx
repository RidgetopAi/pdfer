import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { Button, StatusPill } from "../../design";
import { fetchQueue, type QueueObject } from "../../api/client";
import { useObjectEdits } from "../../hooks/useObjectEdits";
import { colorForLabel } from "./regionColors";
import styles from "./QueueView.module.css";

interface QueueViewProps {
  docId: string;
  // Pages list from the parent — used to translate page_number → page id so
  // double-click can jump back to canvas at the right page.
  pageIdByNumber: Map<number, string>;
  onJumpToObject: (pageId: string, objectId: string) => void;
}

type StatusFilter = "all" | "unreviewed" | "reviewed";
type SortBy = "page" | "confidence";

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "unreviewed", label: "Unreviewed Only" },
  { value: "reviewed", label: "Reviewed Only" },
];

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "page", label: "Page · reading order" },
  { value: "confidence", label: "Confidence — low first" },
];

/**
 * List view of every region in the doc — fast triage without canvas overhead.
 * Filter by status, sort by page or confidence, click to select, double-click
 * to jump back to canvas at that region. Approve / Reject buttons fire the
 * same edit mutations the action bar uses; one-undo-per-edit semantics
 * preserved.
 *
 * Backend supports filters (all|unreviewed|confirmed|low_confidence) and
 * sorts (page|confidence). The "Reviewed Only" UI option does not have a
 * direct server equivalent (server has "confirmed" but not "any reviewed"),
 * so we fetch "all" and filter client-side when that option is active.
 */
export function QueueView({ docId, pageIdByNumber, onJumpToObject }: QueueViewProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("unreviewed");
  const [sortBy, setSortBy] = useState<SortBy>("page");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Server filter: "reviewed" client-filters, the others map directly.
  const serverFilter =
    statusFilter === "all" ? "all"
    : statusFilter === "unreviewed" ? "unreviewed"
    : "all";

  const queueQuery = useQuery({
    queryKey: ["queue", docId, sortBy, serverFilter],
    queryFn: () => fetchQueue(docId, sortBy, serverFilter),
  });

  const qc = useQueryClient();
  const edits = useObjectEdits(docId);

  // Keep cache fresh as edits land — the same WS invalidation that updates
  // canvas state should refresh queue.
  useEffect(() => {
    return qc.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const key = event.query.queryKey;
      if (Array.isArray(key) && (key[0] === "objects" || key[0] === "reviewStats")) {
        qc.invalidateQueries({ queryKey: ["queue", docId] });
      }
    });
  }, [docId, qc]);

  const objects: QueueObject[] = useMemo(() => {
    const all = queueQuery.data?.objects ?? [];
    if (statusFilter === "reviewed") {
      return all.filter((o) => o.status === "confirmed" || o.status === "rejected");
    }
    return all;
  }, [queueQuery.data, statusFilter]);

  // Clamp selected index when filter changes the list
  useEffect(() => {
    if (selectedIndex >= objects.length && objects.length > 0) {
      setSelectedIndex(objects.length - 1);
    } else if (objects.length === 0) {
      setSelectedIndex(0);
    }
  }, [objects.length, selectedIndex]);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.title}>QUEUE</div>
        <div className={styles.count}>{objects.length} regions</div>
        <div style={{ flex: 1 }} />

        <select
          className={styles.select}
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setSelectedIndex(0); }}
          title="Filter by review status"
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <select
          className={styles.select}
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value as SortBy); setSelectedIndex(0); }}
          title="Sort order"
        >
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      <div className={styles.list}>
        {queueQuery.isLoading && (
          <div className={styles.empty}>Loading queue…</div>
        )}
        {!queueQuery.isLoading && objects.length === 0 && (
          <div className={styles.empty}>
            {statusFilter === "unreviewed"
              ? "No unreviewed regions — every box has been triaged."
              : statusFilter === "reviewed"
              ? "No reviewed regions yet."
              : "No regions detected on this document."}
          </div>
        )}
        {objects.map((obj, i) => (
          <QueueRow
            key={obj.object_id}
            obj={obj}
            active={i === selectedIndex}
            onSelect={() => setSelectedIndex(i)}
            onJump={() => {
              const pageId = pageIdByNumber.get(obj.page_number);
              if (pageId) onJumpToObject(pageId, obj.object_id);
            }}
            onApprove={() => edits.approve.mutate(obj.object_id)}
            onReject={() => edits.reject.mutate(obj.object_id)}
            busy={edits.approve.isPending || edits.reject.isPending}
          />
        ))}
      </div>

      <div className={styles.footer}>
        <span>{objects.length === 0 ? "—" : `${selectedIndex + 1} / ${objects.length}`}</span>
        <span className={styles.hint}>Double-click a row to jump to canvas</span>
      </div>
    </div>
  );
}

interface QueueRowProps {
  obj: QueueObject;
  active: boolean;
  onSelect: () => void;
  onJump: () => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}

function QueueRow({ obj, active, onSelect, onJump, onApprove, onReject, busy }: QueueRowProps) {
  const tint = colorForLabel(obj.label);
  const conf = obj.confidence;
  const confPct = conf == null ? null : Math.round(conf * 100);
  const statusTone =
    obj.status === "confirmed" ? "done"
    : obj.status === "rejected" ? "error"
    : "pending";
  const statusLabel = obj.status.toUpperCase();

  return (
    <div
      className={`${styles.row} ${active ? styles.rowActive : ""}`}
      onClick={onSelect}
      onDoubleClick={onJump}
    >
      <span className={styles.pageNum}>p{obj.page_number}</span>
      <span className={styles.labelPill} style={{ ["--tint" as string]: tint }}>
        <span className={styles.labelDot} />
        {obj.label.replace(/_/g, " ")}
      </span>
      <span className={styles.confidence} data-low={conf != null && conf < 0.5 ? "true" : "false"}>
        {confPct != null ? `${confPct}%` : "—"}
      </span>
      <span className={styles.statusCell}>
        <StatusPill tone={statusTone} dot>{statusLabel}</StatusPill>
      </span>
      <div style={{ flex: 1 }} />
      {obj.status === "unreviewed" && active && (
        <div className={styles.actions}>
          <Button
            size="mini"
            variant="approve"
            icon={<Check size={12} />}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); onApprove(); }}
          >
            Approve
          </Button>
          <Button
            size="mini"
            variant="reject"
            icon={<X size={12} />}
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); onReject(); }}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}
