// Launch source: Solana RPC WebSocket logsSubscribe on launchpad programs.
// Works with Solami RPC WebSockets (wss://rpc.solami.dev/ws/sol) or any Solana RPC.
// Decodes Pump.fun's Anchor `CreateEvent` straight from the program logs, so a new
// launch costs zero extra RPC calls to detect.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { base58Encode, PROGRAMS } from "../solana.js";

const CREATE_EVENT_DISC = createHash("sha256").update("event:CreateEvent").digest().subarray(0, 8);

export function decodePumpCreateEvent(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 8 + 12 + 96 || !buf.subarray(0, 8).equals(CREATE_EVENT_DISC)) return null;
  let o = 8;
  const str = () => {
    const len = buf.readUInt32LE(o);
    if (len > 400 || o + 4 + len > buf.length) throw new Error("bad string");
    o += 4;
    const s = buf.subarray(o, o + len).toString("utf8");
    o += len;
    return s;
  };
  const key = () => {
    const k = base58Encode(buf.subarray(o, o + 32));
    o += 32;
    return k;
  };
  try {
    const name = str();
    const symbol = str();
    const uri = str();
    const mint = key();
    const bondingCurve = key();
    const user = key();
    return { name, symbol, uri, mint, bondingCurve, creator: user };
  } catch {
    return null;
  }
}

export class RpcLogsLaunchSource extends EventEmitter {
  constructor(wsUrl, { programs = [PROGRAMS.PUMP_FUN] } = {}) {
    super();
    this.wsUrl = wsUrl;
    this.programs = programs;
    this.ws = null;
    this.stopped = false;
    this.attempt = 0;
    this.stats = { connected: false, messages: 0, launches: 0, lastMessageAt: null, reconnects: 0 };
  }

  start() {
    this.stopped = false;
    this.#connect();
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pinger);
    this.ws?.close();
  }

  #connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.stats.connected = true;
      this.emit("status", { source: "rpc-logs", connected: true });
      this.programs.forEach((program, i) => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe", params: [{ mentions: [program] }, { commitment: "confirmed" }] }));
      });
      clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "getHealth" }));
      }, 30000);
    };
    ws.onmessage = (ev) => {
      this.stats.messages++;
      this.stats.lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const v = msg?.params?.result?.value;
      if (!v || v.err) return;
      const logs = v.logs || [];
      if (!logs.some((l) => /Instruction: Create(V2)?$/.test(l))) return;
      for (const line of logs) {
        if (!line.startsWith("Program data: ")) continue;
        const evt = decodePumpCreateEvent(line.slice(14));
        if (evt) {
          this.stats.launches++;
          this.emit("launch", { ...evt, source: "pump.fun", signature: v.signature, slot: msg.params.result.context?.slot, seenAt: Date.now() });
          break;
        }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.stats.connected = false;
      clearInterval(this.pinger);
      this.emit("status", { source: "rpc-logs", connected: false });
      if (this.stopped) return;
      this.stats.reconnects++;
      const delay = Math.min(30000, 1000 * 2 ** this.attempt++);
      setTimeout(() => this.#connect(), delay);
    };
  }
}
