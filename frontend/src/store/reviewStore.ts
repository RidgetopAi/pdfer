import { create } from "zustand";

export type InteractionMode = "select" | "draw";
export type ViewMode = "review" | "diff";

export interface Toast {
  message: string;
  action?: "undo" | "redo";
  timestamp: number;
}

interface ReviewState {
  // Current page
  currentPageIndex: number;
  setCurrentPageIndex: (i: number) => void;

  // Selection
  selectedObjectIds: Set<string>;
  selectObject: (id: string, multi?: boolean) => void;
  deselectAll: () => void;

  // Interaction mode
  mode: InteractionMode;
  setMode: (mode: InteractionMode) => void;

  // View mode — "review" is the default annotated view; "diff" splits
  // the center stage into clean-original | annotated.
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // Toast (undo feedback)
  toast: Toast | null;
  showToast: (message: string, action?: "undo" | "redo") => void;
  clearToast: () => void;

  // Drawing state
  isDrawing: boolean;
  setIsDrawing: (v: boolean) => void;

  // Track which objects were affected by last action (for flash)
  flashObjectIds: Set<string>;
  setFlashObjectIds: (ids: Set<string>) => void;

  // User zoom multiplier — layered on top of fit-to-container.
  // 1.0 = fit. Range clamped to [ZOOM_MIN, ZOOM_MAX].
  userZoom: number;
  setUserZoom: (z: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.1;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));

export const useReviewStore = create<ReviewState>((set) => ({
  currentPageIndex: 0,
  setCurrentPageIndex: (i) => set({ currentPageIndex: i }),

  selectedObjectIds: new Set(),
  selectObject: (id, multi) =>
    set((state) => {
      if (multi) {
        const next = new Set(state.selectedObjectIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { selectedObjectIds: next };
      }
      return { selectedObjectIds: new Set([id]) };
    }),
  deselectAll: () => set({ selectedObjectIds: new Set() }),

  mode: "select",
  setMode: (mode) => set({ mode }),

  viewMode: "review",
  setViewMode: (viewMode) => set({ viewMode }),

  toast: null,
  showToast: (message, action) =>
    set({ toast: { message, action, timestamp: Date.now() } }),
  clearToast: () => set({ toast: null }),

  isDrawing: false,
  setIsDrawing: (v) => set({ isDrawing: v }),

  flashObjectIds: new Set(),
  setFlashObjectIds: (ids) => set({ flashObjectIds: ids }),

  userZoom: 1,
  setUserZoom: (z) => set({ userZoom: clampZoom(z) }),
  zoomIn: () => set((s) => ({ userZoom: clampZoom(s.userZoom + ZOOM_STEP) })),
  zoomOut: () => set((s) => ({ userZoom: clampZoom(s.userZoom - ZOOM_STEP) })),
  resetZoom: () => set({ userZoom: 1 }),
}));
