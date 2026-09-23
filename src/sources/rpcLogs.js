// Launch source: Solana RPC WebSocket logsSubscribe on launchpad programs.
// Works with Solami RPC WebSockets (wss://rpc.solami.dev/ws/sol) or any Solana RPC.
// Decodes Pump.fun's Anchor `CreateEvent` and `TradeEvent` straight from the program logs, so
// new launches and every buy/sell on them cost zero extra RPC calls.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { base58Encode, PROGRAMS } from "../solana.js";
import { StallWatchdog, dropSocket } from "./watchdog.js";

const CREATE_EVENT_DISC = createHash("sha256").update("event:CreateEvent").digest().subarray(0, 8);
const TRADE_EVENT_DISC = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);

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

// TradeEvent layout (byte offsets): 8 mint, 40 sol_amount, 48 token_amount, 56 is_buy, 57 user,
// 89 timestamp, 97 virtual_sol, 105 virtual_token, 113 real_sol, 121 real_token, 129 fee_recipient,
// 161 fee_bps, 169 fee, 177 creator. Checked against live mainnet trades (374–423 bytes).
export function decodePumpTradeEvent(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 129 || !buf.subarray(0, 8).equals(TRADE_EVENT_DISC)) return null;
  const key = (o) => base58Encode(buf.subarray(o, o + 32));
  const u64 = (o) => buf.readBigUInt64LE(o);
  const vSol = u64(97);
  const vTok = u64(105);
  return {
    mint: key(8),
    sol: Number(u64(40)) / 1e9,
    tokens: u64(48),
    side: buf[56] === 1 ? "buy" : "sell",
    wallet: key(57),
    timestamp: Number(buf.readBigInt64LE(89)),
    priceSol: vTok > 0n ? Number(vSol) / 1e9 / (Number(vTok) / 1e6) : null,
    curveSol: Number(u64(113)) / 1e9,
    creator: buf.length >= 209 ? key(177) : null,
  };
}

export class RpcLogsLaunchSource extends EventEmitter {
  constructor(wsUrl, { programs = [PROGRAMS.PUMP_FUN] } = {}) {
    super();
    this.wsUrl = wsUrl;
    this.programs = programs;
    this.ws = null;
    this.stopped = false;
    this.attempt = 0;
    this.stats = { connected: false, messages: 0, launches: 0, trades: 0, lastMessageAt: null, reconnects: 0 };
  }

  start() {
    this.stopped = false;
    this.#connect();
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pinger);
    this.dog?.stop();
    this.ws?.close();
  }

  #onMessage(ev) {
    this.stats.messages++;
    this.stats.lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg?.method === "logsNotification") this.dog?.touch();
    const v = msg?.params?.result?.value;
    if (!v || v.err) return;
    const data = (v.logs || []).filter((l) => l.startsWith("Program data: ")).map((l) => l.slice(14));
    if (!data.length) return;
    const slot = msg.params.result.context?.slot;
    // Launch first, so the radar knows the token before the creator's first buy in the same tx.
    for (const d of data) {
      const evt = decodePumpCreateEvent(d);
      if (!evt) continue;
      this.stats.launches++;
      this.emit("launch", { ...evt, source: "pump.fun", signature: v.signature, slot, seenAt: Date.now() });
    }
    for (const d of data) {
      const t = decodePumpTradeEvent(d);
      if (!t) continue;
      this.stats.trades++;
      this.emit("trade", { ...t, source: "pump.fun", signature: v.signature, slot });
    }
  }

  #connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.stats.connected = true;
      this.emit("status", { source: "rpc-logs", connected: true });
      this.dog?.stop();
      this.dog = new StallWatchdog(() => {
        this.stats.stalls = (this.stats.stalls || 0) + 1;
        this.emit("warning", { source: "rpc-logs", message: "stream went quiet, reconnecting" });
        dropSocket(ws);
      }).start();
      this.programs.forEach((program, i) => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe", params: [{ mentions: [program] }, { commitment: "confirmed" }] }));
      });
      clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "getHealth" }));
      }, 30000);
    };
    ws.onmessage = (ev) => {
      // A throw inside a WebSocket handler would crash the process; one bad message must not.
      try {
        this.#onMessage(ev);
      } catch (e) {
        this.emit("warning", { source: "rpc-logs", message: `message skipped: ${e.message}` });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.stats.connected = false;
      clearInterval(this.pinger);
      this.dog?.stop();
      this.emit("status", { source: "rpc-logs", connected: false });
      if (this.stopped) return;
      this.stats.reconnects++;
      const delay = Math.min(30000, 1000 * 2 ** this.attempt++);
      setTimeout(() => this.#connect(), delay);
    };
  }
}
