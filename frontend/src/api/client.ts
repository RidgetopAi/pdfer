const API_BASE = "http://localhost:8000";

export interface PageSummary {
  id: string;
  page_number: number;
  width_px: number;
  height_px: number;
  pdf_type: string | null;
  thumb_url: string | null;
  text_span_count: number;
}

export interface DocumentSummary {
  id: string;
  filename: string;
  page_count: number | null;
  current_stage: number;
  stage_status: string;
  created_at: string;
}

export interface DocumentDetail extends DocumentSummary {
  pages: PageSummary[];
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/health`);
  return res.json();
}

export async function fetchDocuments(): Promise<DocumentSummary[]> {
  const res = await fetch(`${API_BASE}/documents`);
  const data = await res.json();
  return data.documents;
}

export async function fetchDocument(id: string): Promise<DocumentDetail> {
  const res = await fetch(`${API_BASE}/documents/${id}`);
  if (!res.ok) throw new Error("Document not found");
  return res.json();
}

export async function uploadDocument(file: File): Promise<DocumentSummary> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/documents`, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

export function thumbUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface DetectedObject {
  id: string;
  page_id: string;
  label: string;
  bbox_x1: number;
  bbox_y1: number;
  bbox_x2: number;
  bbox_y2: number;
  confidence: number | null;
  reading_order: number | null;
  heading_level: number | null;
  source: string;
  status: string;
  description?: string | null;
  description_model?: string | null;
  description_status?: string;
  description_edited_by_user?: number;
  asset_path?: string | null;
}

export interface PageObjects {
  page_id: string;
  page_number: number;
  objects: DetectedObject[];
}

export interface DetectionResponse {
  document_id: string;
  total_objects: number;
  pages: PageObjects[];
}

export async function detectDocument(docId: string, force: boolean = false): Promise<DetectionResponse> {
  const res = await fetch(
    `${API_BASE}/documents/${docId}/detect?force=${force}`,
    { method: "POST" },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

export interface DescribeResponse {
  document_id: string;
  total_described: number;
  failed: number;
  skipped: number;
}

export async function describeDocument(
  docId: string,
  useLlm: boolean = true,
  force: boolean = false,
): Promise<DescribeResponse> {
  const res = await fetch(
    `${API_BASE}/documents/${docId}/describe?use_llm=${useLlm}&force=${force}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export interface DescribeObjectResponse {
  object_id: string;
  description: string | null;
  description_edited_by_user: number;
  training_example_created: boolean;
}

export async function patchObjectDescription(
  objectId: string,
  description: string,
): Promise<DescribeObjectResponse> {
  const res = await fetch(`${API_BASE}/objects/${objectId}/description`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function redescribeObject(
  objectId: string,
  useLlm: boolean = true,
): Promise<DescribeObjectResponse> {
  const res = await fetch(
    `${API_BASE}/objects/${objectId}/redescribe?use_llm=${useLlm}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export interface TrainingStats {
  total: number;
  by_label: Record<string, number>;
  by_pdf_type: Record<string, number>;
  ready_for_training: boolean;
}

export async function fetchTrainingStats(): Promise<TrainingStats> {
  const res = await fetch(`${API_BASE}/training/stats`);
  if (!res.ok) throw new Error("Failed to fetch training stats");
  return res.json();
}

export function trainingExportUrl(): string {
  return `${API_BASE}/training/export?format=jsonl`;
}

export async function fetchObjects(docId: string): Promise<DetectionResponse> {
  const res = await fetch(`${API_BASE}/documents/${docId}/objects`);
  if (!res.ok) throw new Error("Failed to fetch objects");
  return res.json();
}

export function pageImageUrl(docId: string, pageNumber: number): string {
  return `${API_BASE}/pages/${docId}/page_${String(pageNumber).padStart(4, "0")}.png`;
}

export interface EditAction {
  action: string;
  object_id?: string;
  page_id?: string;
  label?: string;
  bbox_x1?: number;
  bbox_y1?: number;
  bbox_x2?: number;
  bbox_y2?: number;
  heading_level?: number;
  threshold?: number;
}

export interface EditBatchResponse {
  batch_id: string;
  description: string;
  affected_objects: DetectedObject[];
}

export interface UndoRedoResponse {
  batch_id: string;
  description: string;
  action: string;
}

export interface UndoState {
  can_undo: boolean;
  undo_description: string | null;
  can_redo: boolean;
  redo_description: string | null;
  total_edits: number;
}

export interface ReviewStats {
  total_objects: number;
  confirmed: number;
  rejected: number;
  unreviewed: number;
  pages_complete: number;
  pages_total: number;
}

export async function submitEdits(docId: string, edits: EditAction[]): Promise<EditBatchResponse> {
  const res = await fetch(`${API_BASE}/documents/${docId}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edits }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function undoAction(docId: string): Promise<UndoRedoResponse> {
  const res = await fetch(`${API_BASE}/documents/${docId}/undo`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function redoAction(docId: string): Promise<UndoRedoResponse> {
  const res = await fetch(`${API_BASE}/documents/${docId}/redo`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchUndoState(docId: string): Promise<UndoState> {
  const res = await fetch(`${API_BASE}/documents/${docId}/undo-state`);
  return res.json();
}

export async function fetchReviewStats(docId: string): Promise<ReviewStats> {
  const res = await fetch(`${API_BASE}/documents/${docId}/review-stats`);
  return res.json();
}

export interface ExtractionResult {
  object_id: string;
  content_type: string;
  extractor: string;
}

export interface ExtractionResponse {
  document_id: string;
  total_extracted: number;
  extractions: ExtractionResult[];
}

export interface ExtractionDetail {
  id: string;
  object_id: string;
  content: string | null;
  content_type: string;
  extractor: string;
  confidence: number | null;
  metadata: Record<string, unknown>;
}

export interface ExtractionsListResponse {
  document_id: string;
  total: number;
  extractions: ExtractionDetail[];
}

export async function extractDocument(docId: string, useLlm: boolean = true): Promise<ExtractionResponse> {
  const res = await fetch(`${API_BASE}/documents/${docId}/extract?use_llm=${useLlm}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchExtractions(docId: string): Promise<ExtractionsListResponse> {
  const res = await fetch(`${API_BASE}/documents/${docId}/extractions`);
  if (!res.ok) throw new Error("Failed to fetch extractions");
  return res.json();
}

export interface AssemblyResponse {
  document_id: string;
  markdown: string;
  asset_count: number;
  total_objects: number;
  total_corrections: number;
}

export interface QueueObject {
  object_id: string;
  page_number: number;
  label: string;
  confidence: number | null;
  status: string;
  bbox_x1: number;
  bbox_y1: number;
  bbox_x2: number;
  bbox_y2: number;
  extraction_status: string;
}

export interface QueueViewResponse {
  document_id: string;
  total: number;
  objects: QueueObject[];
}

export async function assembleDocument(docId: string): Promise<AssemblyResponse> {
  const res = await fetch(`${API_BASE}/documents/${docId}/assemble`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function fetchMarkdown(docId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/documents/${docId}/markdown`);
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

export function bundleUrl(docId: string): string {
  return `${API_BASE}/documents/${docId}/bundle.zip`;
}

export async function fetchQueue(
  docId: string,
  sortBy: string = "confidence",
  statusFilter: string = "all",
): Promise<QueueViewResponse> {
  const res = await fetch(
    `${API_BASE}/documents/${docId}/queue?sort_by=${sortBy}&status_filter=${statusFilter}`,
  );
  if (!res.ok) throw new Error("Failed to fetch queue");
  return res.json();
}

export function connectWebSocket(docId: string, onMessage: (event: string, data: unknown) => void) {
  const ws = new WebSocket(`ws://localhost:8000/ws/documents/${docId}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    onMessage(msg.event, msg.data);
  };
  return ws;
}

/* =====================================================================
   Training corpus — stats + per-doc YOLO export.
   The export endpoint streams a zip in canonical Ultralytics format
   (images/, labels/, data.yaml). Stats lets the dashboard show how big
   the corpus is across all docs without downloading anything.
===================================================================== */

export interface TrainingExportStats {
  pages_complete: number;
  pages_in_progress: number;
  exportable_boxes: number;
  manual_boxes_total: number;
  confirmed_boxes_total: number;
  per_class: Record<string, number>;
  per_document: { document_id: string; filename: string; pages_complete: number }[];
}

export async function fetchTrainingExportStats(): Promise<TrainingExportStats> {
  const res = await fetch(`${API_BASE}/training/yolo-export-stats`);
  if (!res.ok) throw new Error(`Failed to load training stats: ${res.status}`);
  return res.json();
}

export function yoloExportUrl(docId: string, includeInProgress = false): string {
  const qs = includeInProgress ? "?include_in_progress=true" : "";
  return `${API_BASE}/documents/${docId}/yolo-export${qs}`;
}

/* =====================================================================
   Model status — which heavy model (YOLO / Gemma) currently owns the GPU,
   plus per-model load state. Surfaced in the dashboard footer so the user
   doesn't have to alt-tab to btop to know whether anything is running.
===================================================================== */

export type ModelLoadState = "loaded" | "unloaded";

export interface ModelStatus {
  active: "yolo" | "gemma" | null;
  yolo: ModelLoadState;
  gemma: ModelLoadState;
  vram_mib: number | null;
}

export async function fetchModelStatus(): Promise<ModelStatus> {
  const res = await fetch(`${API_BASE}/models/status`);
  if (!res.ok) throw new Error(`Failed to load model status: ${res.status}`);
  return res.json();
}

/* =====================================================================
   Settings endpoint (Phase 4).
   Backend implementation pending — see Mandrel task effdeb1c.
   Until it lands, GET returns 404, which the UI renders as
   "Backend endpoint pending" rather than silent failure.
===================================================================== */

export interface SettingsResponse {
  watch_folder: string | null;
}

export class SettingsNotImplementedError extends Error {
  constructor() {
    super("Settings endpoint not implemented by backend");
    this.name = "SettingsNotImplementedError";
  }
}

export async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch(`${API_BASE}/settings`);
  if (res.status === 404) throw new SettingsNotImplementedError();
  if (!res.ok) throw new Error(`Failed to load settings: ${res.status}`);
  return res.json();
}

export async function updateSettings(payload: { watch_folder: string }): Promise<SettingsResponse> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 404) throw new SettingsNotImplementedError();
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
