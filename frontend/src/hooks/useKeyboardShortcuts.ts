import { useEffect } from "react";

export interface ShortcutHandlers {
  onApprove?: () => void;
  onReject?: () => void;
  onNextPage?: () => void;
  onPrevPage?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onEscape?: () => void;
  onDelete?: () => void;
  onToggleDraw?: () => void;
}

/**
 * Global keyboard shortcuts for the Review screen.
 *   A             → approve selected
 *   R             → reject selected
 *   D             → toggle draw mode
 *   Delete/Bksp   → delete selected region
 *   ← / →         → prev / next page
 *   Ctrl/Cmd+Z    → undo
 *   Ctrl/Cmd+Shift+Z (or Ctrl+Y) → redo
 *   Esc           → exit draw mode → exit diff view → deselect
 *
 * Bound to window only when the enabled flag is true so we don't steal
 * keys from inputs or other screens.
 */
export function useKeyboardShortcuts(enabled: boolean, handlers: ShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Ignore when typing into an editable field.
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }

      const mod = e.metaKey || e.ctrlKey;

      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        handlers.onUndo?.();
        return;
      }
      if ((mod && e.shiftKey && e.key.toLowerCase() === "z") || (mod && e.key.toLowerCase() === "y")) {
        e.preventDefault();
        handlers.onRedo?.();
        return;
      }

      // Single-key shortcuts below must not fire when a modifier is held.
      if (mod || e.altKey) return;

      switch (e.key) {
        case "a":
        case "A":
          e.preventDefault();
          handlers.onApprove?.();
          break;
        case "r":
        case "R":
          e.preventDefault();
          handlers.onReject?.();
          break;
        case "d":
        case "D":
          e.preventDefault();
          handlers.onToggleDraw?.();
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          handlers.onDelete?.();
          break;
        case "ArrowRight":
          e.preventDefault();
          handlers.onNextPage?.();
          break;
        case "ArrowLeft":
          e.preventDefault();
          handlers.onPrevPage?.();
          break;
        case "Escape":
          handlers.onEscape?.();
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, handlers]);
}
