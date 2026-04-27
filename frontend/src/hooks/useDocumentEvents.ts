import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { connectWebSocket } from "../api/client";

/**
 * Backend event names (from backend/app/services/*):
 *   document.ingested, page.detected, object.edited,
 *   object.description_edited, object.described, object.extracted,
 *   document.assembled, stage.completed
 */
export type DocumentEvent =
  | "document.ingested"
  | "page.detected"
  | "object.edited"
  | "object.description_edited"
  | "object.described"
  | "object.extracted"
  | "document.assembled"
  | "stage.completed";

export type DocumentEventHandler = (event: DocumentEvent, data: unknown) => void;

interface Options {
  /** Extra side-effect hook — runs AFTER query invalidation. */
  onEvent?: DocumentEventHandler;
  /** Skip connection entirely (e.g. docId unknown yet). */
  enabled?: boolean;
}

/**
 * Subscribe to per-document WebSocket events. Handles reconnect with
 * exponential backoff. Invalidates the relevant React Query keys so
 * dependent UI (Dashboard matrix, Review panels) auto-refreshes.
 *
 * The Dashboard subscribes with docId=null to ALL document streams only
 * via polling (we don't open one socket per doc); per-doc subscription
 * is for the Review screen. Phase 5 wires Dashboard via refetchInterval
 * polling; per-doc live glow comes online once user enters Review.
 */
export function useDocumentEvents(docId: string | null | undefined, options: Options = {}) {
  const qc = useQueryClient();
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;

  const enabled = options.enabled !== false && Boolean(docId);

  useEffect(() => {
    if (!enabled || !docId) return;

    let ws: WebSocket | null = null;
    let closed = false;
    let retryMs = 1_000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      ws = connectWebSocket(docId, (event, data) => {
        // Route event → cache invalidation
        switch (event as DocumentEvent) {
          case "document.ingested":
          case "stage.completed":
          case "document.assembled":
            qc.invalidateQueries({ queryKey: ["documents"] });
            qc.invalidateQueries({ queryKey: ["document", docId] });
            qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
            break;
          case "page.detected":
          case "object.edited":
          case "object.described":
          case "object.description_edited":
          case "object.extracted":
            qc.invalidateQueries({ queryKey: ["objects", docId] });
            qc.invalidateQueries({ queryKey: ["reviewStats", docId] });
            qc.invalidateQueries({ queryKey: ["undoState", docId] });
            break;
        }
        onEventRef.current?.(event as DocumentEvent, data);
      });

      ws.onopen = () => {
        retryMs = 1_000; // reset backoff on successful connect
      };
      ws.onclose = () => {
        if (closed) return;
        retryTimer = setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      };
      ws.onerror = () => {
        // onclose will fire too — handle reconnect there.
      };
    };

    open();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [docId, enabled, qc]);
}
