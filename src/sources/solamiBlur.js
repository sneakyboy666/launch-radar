// Solami Blur: decoded Solana market data over WebSocket (https://solami.dev/docs/blur).
// Endpoint: wss://ws.solami.dev/data/subscribe?chain=solana&api_key=...
//
// Launch Radar opens two Blur streams:
//   launches: every token_create and graduation, on every launchpad (pumpfun, raydium_launchpad,
//             meteora_dbc, ...), filtered by type at connect time
//   tracked:  swaps, transfers, liquidity changes and volume surges for exactly the tokens the
//             radar is watching; the mint filter is replaced live as new tokens launch
// Blur sends fractional numbers as decimal strings and raw u64 amounts as integers or strings.
import { appendFileSync, mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { isValidPubkey } from "../solana.js";
import { StallWatchdog, dropSocket } from "./watchdog.js";

const WSOL = "So11111111111111111111111111111111111111112";
const num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
const big = (v) => {
  try {
    return v === undefined || v === null ? null : BigInt(typeof v === "number" ? Math.trunc(v) : String(v).split(".")[0]);
  } catch {
    return null;
  }
};
const key = (v) => (typeof v === "string" && isValidPubkey(v) ? v : null);

// Map one Blur frame to a radar event, or null for frames the radar doesn't use.
export function normalizeBlurEvent(m) {
  switch (m?.type) {
    case "token_create": {
      const mint = key(m.mint);
      if (!mint || m.kind === "pool") return null;
      return { type: "launch", mint, name: m.name || "", symbol: m.symbol || "", uri: m.uri || "", creator: key(m.creator), pool: key(m.pool), dex: m.dex || null, source: `solami: ${m.dex || "launch"}`, signature: m.signature || null };
    }
    case "swap": {
      const mint = key(m.mint);
      if (!mint) return null;
      const quote = num(m.quote_amount);
      return {
        type: "trade",
        mint,
        side: m.side === "buy" ? "buy" : "sell",
        usd: num(m.volume_usd) ?? 0,
        priceUsd: num(m.price_usd),
        mcapUsd: num(m.mcap_usd),
        sol: m.quote_mint === WSOL && quote !== null ? quote / 1e9 : undefined,
        tokens: big(m.base_amount),
        wallet: key(m.trader),
        dex: m.dex || null,
        pool: key(m.pool),
        signature: m.signature || null,
        source: "solami-blur",
      };
    }
    case "transfer": {
      const mint = key(m.mint);
      if (!mint) return null;
      return { type: "transfer", mint, kind: m.kind || "transfer", from: key(m.src_owner), to: key(m.dst_owner), amount: big(m.amount), signature: m.signature || null };
    }
    case "liquidity": {
      const mint = key(m.base_mint);
      if (!mint) return null;
      return { type: "liquidity", mint, kind: m.kind, provider: key(m.provider), usd: (num(m.base_usd) ?? 0) + (num(m.quote_usd) ?? 0), pool: key(m.pool), dex: m.dex || null, signature: m.signature || null };
    }
    case "graduation": {
      const mint = key(m.mint);
      return mint ? { type: "graduation", mint, launchpad: m.launchpad || null, pool: key(m.pool), dex: m.dex || null } : null;
    }
    case "surge": {
      const mint = key(m.mint);
      return mint ? { type: "surge", mint, multiple: num(m.multiple), volumeUsd: num(m.volume_window_usd), windowSecs: m.window_secs ?? null } : null;
    }
    case "token_update": {
      const mint = key(m.mint);
      return mint ? { type: "market", mint, liquidityUsd: num(m.liquidity_usd), mcapUsd: num(m.mcap_usd), buys5m: m.buys_5m ?? null, sells5m: m.sells_5m ?? null, volume5mUsd: num(m.volume_5m_usd) } : null;
    }
    default:
      return null;
  }
}

export class SolamiBlurSource extends EventEmitter {
  // name: label for status/warnings; query: connect-time filter (e.g. "type=token_create,graduation");
  // types: event types for the live filter used with setMints(); discoverDir: record raw frames.
  constructor(url, { name = "solami-blur", query = "", types = null, discoverDir = null, staleMs = 60000 } = {}) {
    super();
    this.url = url;
    this.name = name;
    this.query = query;
    this.types = types;
    this.mints = [];
    this.staleMs = staleMs;
    this.discoverDir = discoverDir;
    this.discovered = 0;
    this.stopped = false;
    this.attempt = 0;
    this.stats = { connected: false, messages: 0, launches: 0, trades: 0, transfers: 0, liquidity: 0, graduations: 0, surges: 0, markets: 0, other: 0, filterUpdates: 0, lastMessageAt: null, reconnects: 0 };
  }

  start() {
    if (!this.url) return this;
    this.stopped = false;
    // A tracked stream with no mints yet would be the whole firehose: wait for setMints().
    if (!this.types || this.mints.length) this.#connect();
    return this;
  }

  stop() {
    this.stopped = true;
    this.dog?.stop();
    this.ws?.close();
  }

  // Replace the tracked-token filter (Blur replaces the whole filter on every update).
  setMints(mints) {
    this.mints = [...new Set(mints)].slice(0, 300);
    if (!this.mints.length || this.stopped || !this.url) return;
    if (!this.ws) return this.#connect();
    if (this.ready) this.#sendFilter();
  }

  #sendFilter() {
    if (!this.types || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ filter: { types: this.types, mints: this.mints } }));
    this.stats.filterUpdates++;
  }

  #record(raw) {
    if (!this.discoverDir || this.discovered >= 300) return;
    mkdirSync(this.discoverDir, { recursive: true });
    appendFileSync(join(this.discoverDir, "blur-sample.jsonl"), raw + "\n");
    this.discovered++;
  }

  #onMessage(ev) {
    this.stats.messages++;
    this.stats.lastMessageAt = Date.now();
    this.dog?.touch();
    const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
    this.#record(text);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg?.type === "connected") {
      // The server takes a live filter only after it has said hello.
      this.ready = true;
      if (this.types) this.#sendFilter();
      return;
    }
    const n = normalizeBlurEvent(msg);
    if (!n) {
      this.stats.other++;
      return;
    }
    const counter = { launch: "launches", trade: "trades", transfer: "transfers", liquidity: "liquidity", graduation: "graduations", surge: "surges", market: "markets" }[n.type];
    this.stats[counter]++;
    this.emit(n.type, { ...n, seenAt: Date.now() });
  }

  #connect() {
    this.ready = false;
    const sep = this.url.includes("?") ? "&" : "?";
    const ws = new WebSocket(this.query ? `${this.url}${sep}${this.query}` : this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.stats.connected = true;
      this.emit("status", { source: this.name, connected: true });
      this.dog?.stop();
      this.dog = new StallWatchdog(() => {
        this.stats.stalls = (this.stats.stalls || 0) + 1;
        this.emit("warning", { source: this.name, message: "stream went quiet, reconnecting" });
        dropSocket(ws);
      }, this.staleMs).start();
    };
    ws.onmessage = (ev) => {
      try {
        this.#onMessage(ev);
      } catch (e) {
        this.emit("warning", { source: this.name, message: `message skipped: ${e.message}` });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.stats.connected = false;
      this.ready = false;
      this.dog?.stop();
      this.emit("status", { source: this.name, connected: false });
      if (this.stopped) return;
      this.stats.reconnects++;
      setTimeout(() => this.#connect(), Math.min(30000, 1000 * 2 ** this.attempt++));
    };
  }
}
