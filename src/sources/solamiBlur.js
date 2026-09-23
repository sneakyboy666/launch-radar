// Solami Blur: decoded market data (trades, token launches, pools) over WebSocket.
// Endpoint: wss://ws.solami.dev/data/subscribe?chain=solana&api_key=...
//
// The field names below are normalized defensively (several spellings are accepted).
// Run `launch-radar discover` once with a key to record real messages to
// data/blur-sample.jsonl and tighten the mapping.
import { appendFileSync, mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { isValidPubkey } from "../solana.js";

const pick = (o, ...keys) => {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

export function normalizeBlurEvent(raw) {
  const e = raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? { ...raw, ...raw.data } : raw;
  const kind = String(pick(e, "type", "event", "kind", "channel") || "").toLowerCase();
  const mint = pick(e, "mint", "token_address", "tokenAddress", "base_mint", "baseMint", "token");
  if (typeof mint !== "string" || !isValidPubkey(mint)) return null;
  if (/launch|create|new_?token|mint/.test(kind)) {
    return {
      type: "launch",
      mint,
      name: pick(e, "name", "token_name", "tokenName") || "",
      symbol: pick(e, "symbol", "token_symbol", "tokenSymbol") || "",
      creator: pick(e, "creator", "deployer", "user", "owner") || null,
      source: pick(e, "dex", "platform", "program", "source") || "blur",
      signature: pick(e, "signature", "tx", "txid") || null,
    };
  }
  if (/swap|trade/.test(kind) || pick(e, "side", "is_buy", "isBuy") !== undefined) {
    const sideRaw = pick(e, "side", "direction");
    const isBuy = pick(e, "is_buy", "isBuy");
    const side = isBuy !== undefined ? (isBuy ? "buy" : "sell") : /buy/i.test(String(sideRaw || "")) ? "buy" : "sell";
    const usd = Number(pick(e, "volume_usd", "amount_usd", "usd", "value_usd", "volumeUsd") || 0);
    return {
      type: "trade",
      mint,
      side,
      usd: Number.isFinite(usd) ? usd : 0,
      priceUsd: Number(pick(e, "price_usd", "priceUsd", "price") || 0) || null,
      wallet: pick(e, "wallet", "trader", "owner", "maker", "signer") || null,
      dex: pick(e, "dex", "program", "source") || null,
      signature: pick(e, "signature", "tx", "txid") || null,
    };
  }
  if (/pool|liquidity/.test(kind)) {
    return { type: "pool", mint, dex: pick(e, "dex", "program", "source") || null, liquidityUsd: Number(pick(e, "liquidity_usd", "liquidityUsd") || 0) || null };
  }
  return null;
}

export class SolamiBlurSource extends EventEmitter {
  constructor(url, { subscriptions = [{ type: "swap" }, { type: "launch" }, { type: "pool" }], discoverDir = null } = {}) {
    super();
    this.url = url;
    this.subscriptions = subscriptions;
    this.discoverDir = discoverDir;
    this.discovered = 0;
    this.stopped = false;
    this.attempt = 0;
    this.stats = { connected: false, messages: 0, trades: 0, launches: 0, pools: 0, unknown: 0, lastMessageAt: null, reconnects: 0 };
  }

  start() {
    if (!this.url) return this;
    this.stopped = false;
    this.#connect();
    return this;
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  #record(raw) {
    if (!this.discoverDir || this.discovered >= 300) return;
    mkdirSync(this.discoverDir, { recursive: true });
    appendFileSync(join(this.discoverDir, "blur-sample.jsonl"), raw + "\n");
    this.discovered++;
  }

  #connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.stats.connected = true;
      this.emit("status", { source: "solami-blur", connected: true });
      for (const sub of this.subscriptions) ws.send(JSON.stringify(sub));
    };
    ws.onmessage = (ev) => {
      this.stats.messages++;
      this.stats.lastMessageAt = Date.now();
      const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
      this.#record(text);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const items = Array.isArray(msg) ? msg : Array.isArray(msg?.data) ? msg.data : Array.isArray(msg?.events) ? msg.events : [msg];
      for (const item of items) {
        const n = normalizeBlurEvent(item);
        if (!n) {
          this.stats.unknown++;
          continue;
        }
        this.stats[n.type === "trade" ? "trades" : n.type === "launch" ? "launches" : "pools"]++;
        this.emit(n.type, { ...n, seenAt: Date.now() });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.stats.connected = false;
      this.emit("status", { source: "solami-blur", connected: false });
      if (this.stopped) return;
      this.stats.reconnects++;
      setTimeout(() => this.#connect(), Math.min(30000, 1000 * 2 ** this.attempt++));
    };
  }
}
