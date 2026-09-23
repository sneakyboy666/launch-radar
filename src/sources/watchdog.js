// Some endpoints stop streaming without closing the socket (seen on the public RPC during a
// soak test). A stream that goes quiet for too long is dropped and reconnected.
export const STALE_MS = 30000; // these streams carry 100+ messages/s; 30s of silence means stuck

export class StallWatchdog {
  constructor(onStall, staleMs = STALE_MS) {
    this.onStall = onStall;
    this.staleMs = staleMs;
  }

  start() {
    this.last = Date.now();
    this.timer = setInterval(() => {
      if (Date.now() - this.last <= this.staleMs) return;
      this.stop();
      this.onStall();
    }, Math.min(10000, this.staleMs / 3));
    this.timer.unref?.();
    return this;
  }

  touch() {
    this.last = Date.now();
  }

  stop() {
    clearInterval(this.timer);
  }
}

// Close a socket and run its close handler now, instead of waiting for a close handshake
// from a peer that may never answer. Later events from the old socket are ignored.
export function dropSocket(ws) {
  const onclose = ws.onclose;
  ws.onclose = null;
  ws.onmessage = null;
  ws.onerror = () => {};
  try {
    ws.close();
  } catch {}
  onclose?.();
}
