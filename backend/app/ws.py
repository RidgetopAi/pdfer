"""WebSocket connection manager for real-time events."""
import json
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        self._connections: dict[str, list[WebSocket]] = {}

    async def connect(self, document_id: str, ws: WebSocket):
        await ws.accept()
        self._connections.setdefault(document_id, []).append(ws)

    def disconnect(self, document_id: str, ws: WebSocket):
        conns = self._connections.get(document_id, [])
        if ws in conns:
            conns.remove(ws)

    async def broadcast(self, document_id: str, event: str, data: dict):
        message = json.dumps({"event": event, "data": data})
        conns = self._connections.get(document_id, [])
        dead = []
        for ws in conns:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            conns.remove(ws)


manager = ConnectionManager()
