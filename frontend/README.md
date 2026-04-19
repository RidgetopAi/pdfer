# PDFer — Frontend

React + TypeScript + Vite app that drives the PDFer review workflow. Talks to the FastAPI backend at `http://localhost:8000` over HTTP + one WebSocket per document.

For the full project overview, see [../README.md](../README.md). For a task-based walkthrough, see [../USER-GUIDE.md](../USER-GUIDE.md).

## Stack

- React 19 + TypeScript
- Vite 8 (dev server on port 5173)
- TanStack Query for server state
- Zustand for UI state
- Konva / react-konva for the review canvas

## Scripts

```bash
npm install        # once
npm run dev        # dev server with HMR
npm run build      # tsc --build + vite build (production bundle)
npm run lint       # eslint
npm run preview    # serve the production build
```

The dev server proxies nothing; the API client (`src/api/client.ts`) points at `http://localhost:8000` directly. Backend CORS allows any `http://localhost:*` / `http://127.0.0.1:*` origin, so Vite picking an alternate port (5174, 5178…) when 5173 is busy just works.

## Source layout

```
src/
├── App.tsx                    # Router shell (upload vs. workspace)
├── main.tsx                   # Entry + QueryClient
├── api/client.ts              # Typed API client + WS helper
├── store/                     # Zustand stores (UI state)
└── components/
    ├── UploadForm.tsx         # Stage 0 trigger
    ├── DocumentList.tsx
    ├── DocumentDetail.tsx
    ├── Workspace.tsx          # Top-level review shell + stage toolbar
    ├── PageList.tsx           # Left panel with thumbnails
    ├── PageCanvas.tsx         # Read-only page renderer
    ├── ReviewCanvas.tsx       # Konva canvas for editing objects
    ├── ObjectInspector.tsx    # Right panel — label, confidence, status
    └── QueueView.tsx          # Keyboard triage (j/k/Enter/X/G)
```

## Key behaviors

- **WebSocket per document.** `connectWebSocket(docId, onMessage)` subscribes to `document.ingested`, `object.edited`, `object.extracted`, and `document.assembled`. The Workspace invalidates React Query caches on relevant events.
- **Stage toolbar.** Buttons unlock as stages advance: Detect (stage ≥ 0), Extract (stage ≥ 1 *and* review complete), Assemble (stage ≥ 2), Download Bundle (stage ≥ 4).
- **Three center-panel modes.** Canvas (default), Queue View, Markdown Preview — toggled from the top bar.
- **Undo/redo.** `Ctrl+Z` / `Ctrl+Shift+Z` hit the backend's journaled undo stack; the UI refreshes off the WS event.

## Known gaps

- Markdown preview renders raw monospace, not parsed HTML.
- No client-side optimistic updates — every edit round-trips the API.
- Error boundaries are minimal; network failures surface as toasts.
