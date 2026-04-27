/**
 * Backend stage semantics (from backend/app/database.py + services/*):
 *   0 = Ingest     (upload + page rendering)
 *   1 = Detect     (YOLO + layout detection)
 *   2 = Extract    (content extraction per object)
 *   3 = Assemble   (markdown + asset bundling running)
 *   4 = Export     (bundle.zip ready)
 * stage_status: 'pending' | 'running' | 'complete' | 'failed'
 *
 * The UI shows 5 columns — Ingest / Detect / Review / Assemble / Export.
 * Review has NO backend stage; it sits between Detect-complete and
 * Extract-run, driven by review-stats (pages_complete / pages_total).
 */

export const STAGE_LABELS = ["Ingest", "Detect", "Review", "Assemble", "Export"] as const;
export type StageLabel = (typeof STAGE_LABELS)[number];

/** One of five cell fill levels, 0 = untouched, 4 = fully complete (brightest). */
export type CellLevel = 0 | 1 | 2 | 3 | 4;

export interface CellState {
  level: CellLevel;
  current: boolean;  // breathing glow — actively processing OR awaiting user
  failed: boolean;
}

interface Inputs {
  current_stage: number;
  stage_status: string;
  review?: { pages_complete: number; pages_total: number } | undefined;
}

/**
 * Map a document's backend state into the 5 UI cells for its matrix row.
 *
 * Fill levels:
 *   cell i filled (level 4) if the user has *completed* that UI stage
 *   cell i partial (level 2-3) if it's the one actively in motion
 *   cell i empty (0-1) if future
 *
 * Current breathing:
 *   Ingest   → backend stage 0 running
 *   Detect   → backend stage 1 running
 *   Review   → stage=1 complete but pages_complete < pages_total
 *   Assemble → backend stage 3 running
 *   Export   → backend stage 4 transitioning (never "running" long)
 */
export function mapDocumentToCells({ current_stage, stage_status, review }: Inputs): CellState[] {
  const cells: CellState[] = [
    { level: 0, current: false, failed: false },
    { level: 0, current: false, failed: false },
    { level: 0, current: false, failed: false },
    { level: 0, current: false, failed: false },
    { level: 0, current: false, failed: false },
  ];
  const failed = stage_status === "failed";

  // Ingest (col 0) ← backend stage 0
  if (current_stage >= 1) cells[0].level = 4;
  else if (current_stage === 0 && stage_status === "complete") cells[0].level = 4;
  else if (current_stage === 0 && stage_status === "running") { cells[0].level = 2; cells[0].current = true; }
  else if (current_stage === 0 && stage_status === "pending") cells[0].level = 1;

  // Detect (col 1) ← backend stage 1
  if (current_stage >= 2) cells[1].level = 4;
  else if (current_stage === 1 && stage_status === "complete") cells[1].level = 4;
  else if (current_stage === 1 && stage_status === "running") { cells[1].level = 2; cells[1].current = true; }
  else if (current_stage === 1 && stage_status === "pending") cells[1].level = 1;

  // Review (col 2) ← derived from review stats
  const reviewDone = review ? review.pages_total > 0 && review.pages_complete >= review.pages_total : false;
  if (current_stage >= 2) {
    // extraction started or past → review must be considered done to proceed
    cells[2].level = 4;
  } else if (current_stage === 1 && stage_status === "complete") {
    // awaiting user review
    if (reviewDone) cells[2].level = 4;
    else {
      cells[2].level = review && review.pages_total > 0
        ? (Math.round((review.pages_complete / review.pages_total) * 3) as CellLevel) || 1
        : 1;
      cells[2].current = true;
    }
  }

  // Assemble (col 3) ← backend stage 3
  if (current_stage >= 4) cells[3].level = 4;
  else if (current_stage === 3 && stage_status === "complete") cells[3].level = 4;
  else if (current_stage === 3 && stage_status === "running") { cells[3].level = 2; cells[3].current = true; }
  else if (current_stage === 2 && stage_status === "complete") cells[3].level = 1;

  // Export (col 4) ← backend stage 4
  if (current_stage === 4 && stage_status === "complete") cells[4].level = 4;
  else if (current_stage === 4 && stage_status === "running") { cells[4].level = 2; cells[4].current = true; }
  else if (current_stage === 3 && stage_status === "complete") cells[4].level = 1;

  if (failed) {
    // mark the current stage cell as failed
    const idx = backendStageToUIIndex(current_stage);
    if (idx >= 0) cells[idx].failed = true;
  }

  return cells;
}

function backendStageToUIIndex(stage: number): number {
  switch (stage) {
    case 0: return 0;  // Ingest
    case 1: return 1;  // Detect
    case 2: return 3;  // Extract maps into Assemble prep
    case 3: return 3;  // Assemble
    case 4: return 4;  // Export
    default: return -1;
  }
}
