// Trap watch: catches every NEW Token-2022 mint that initializes an extension that can be
// used against buyers (permanent delegate, transfer fee, transfer hook, default-frozen
// accounts, non-transferable, pausable). Filters on program logs first, so only the rare
// risky mints cost an extra RPC call (getTransaction) to find the mint address.
import { EventEmitter } from "node:events";
import { base58Decode, PROGRAMS } from "../solana.js";
import { StallWatchdog, dropSocket } from "./watchdog.js";

export const RISKY_INIT = {
  InitializePermanentDelegate: "permanent delegate",
  InitializeTransferFeeConfig: "transfer fee",
  InitializeTransferHook: "transfer hook",
  InitializeDefaultAccountState: "default account state",
  InitializeNonTransferableMint: "non-transferable",
  InitializePausableConfig: "pausable",
};
const RISKY_RE = new RegExp(`Instruction: (${Object.keys(RISKY_INIT).join("|")})`, "g");

export function riskyExtensionsInLogs(logs) {
  if (!logs.some((l) => l.includes("Instruction: InitializeMint"))) return [];
  const found = new Set();
  for (const l of logs) for (const m of l.matchAll(RISKY_RE)) found.add(RISKY_INIT[m[1]]);
  return [...found];
}

// Mints created by Token-2022 InitializeMint (opcode 0) / InitializeMint2 (opcode 20) in a
// transaction. Works on raw ("json") and parsed ("jsonParsed") responses, since RPCs differ: some
// return inner instructions raw even when parsed output is requested.
export function mintsFromTx(tx) {
  const msg = tx?.transaction?.message;
  if (!msg) return [];
  const keys = (msg.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const parsedKeys = (msg.accountKeys || []).some((k) => typeof k === "object" && k?.source);
  const loaded = tx.meta?.loadedAddresses;
  if (loaded && !parsedKeys) keys.push(...(loaded.writable || []), ...(loaded.readonly || []));
  const mints = new Set();
  const visit = (ix) => {
    const program = ix?.programId ?? keys[ix?.programIdIndex];
    if (program !== PROGRAMS.TOKEN_2022) return;
    if (ix.parsed) {
      if (/^initializeMint2?$/.test(ix.parsed.type) && ix.parsed.info?.mint) mints.add(ix.parsed.info.mint);
      return;
    }
    if (typeof ix.data !== "string" || !ix.accounts?.length) return;
    let op;
    try {
      op = base58Decode(ix.data)[0];
    } catch {
      return;
    }
    if (op !== 0 && op !== 20) return;
    const a = ix.accounts[0];
    const mint = typeof a === "number" ? keys[a] : a;
    if (mint) mints.add(mint);
  };
  for (const ix of msg.instructions || []) visit(ix);
  for (const inner of tx.meta?.innerInstructions || []) for (const ix of inner.instructions || []) visit(ix);
  return [...mints];
}
export const mintsFromParsedTx = mintsFromTx;

export class Token2022TrapWatch extends EventEmitter {
  constructor(wsUrl, rpc, { fallbackUrl = null } = {}) {
    super();
    this.wsUrl = wsUrl;
    this.fallbackUrl = fallbackUrl;
    this.failedOpens = 0;
    this.rpc = rpc;
    this.stopped = false;
    this.attempt = 0;
    this.seen = new Set();
    this.stats = { connected: false, messages: 0, newMints: 0, riskyMints: 0, byExtension: {}, lastMessageAt: null, reconnects: 0 };
  }

  start() {
    this.stopped = false;
    this.#connect();
    return this;
  }

  stop() {
    this.stopped = true;
    this.dog?.stop();
    this.ws?.close();
  }

  async #resolve(signature, extensions, slot) {
    try {
      // Raw encoding: identical on every RPC; the fee payer (first account) is the creator.
      const tx = await this.rpc.call("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
      const k0 = tx?.transaction?.message?.accountKeys?.[0];
      const creator = typeof k0 === "string" ? k0 : k0?.pubkey ?? null;
      const mints = mintsFromTx(tx);
      if (!mints.length) this.stats.unresolved = (this.stats.unresolved || 0) + 1;
      for (const mint of mints) {
        if (this.seen.has(mint)) continue;
        this.seen.add(mint);
        this.emit("launch", { mint, name: "", symbol: "", creator, source: `token-2022: ${extensions.join(", ")}`, dex: "token-2022", signature, slot, seenAt: Date.now() });
      }
    } catch (e) {
      // Never emit "error": an EventEmitter with no listener would crash the process.
      this.stats.lookupErrors = (this.stats.lookupErrors || 0) + 1;
      this.emit("warning", { source: "token2022-traps", message: e.message, signature });
    }
  }

  #onMessage(ev) {
    this.stats.messages++;
    this.stats.lastMessageAt = Date.now();
    this.dog?.touch();
    const text = typeof ev.data === "string" ? ev.data : "";
    if (!text.includes("InitializeMint")) return; // cheap pre-filter before JSON.parse
    let v;
    try {
      v = JSON.parse(text)?.params?.result;
    } catch {
      return;
    }
    if (!v?.value || v.value.err) return;
    this.stats.newMints++;
    const exts = riskyExtensionsInLogs(v.value.logs || []);
    if (!exts.length) return;
    this.stats.riskyMints++;
    for (const e of exts) this.stats.byExtension[e] = (this.stats.byExtension[e] || 0) + 1;
    this.#resolve(v.value.signature, exts, v.context?.slot);
  }

  #connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.failedOpens = 0;
      this.attempt = 0;
      this.stats.connected = true;
      this.emit("status", { source: "token2022-traps", connected: true });
      this.dog?.stop();
      this.dog = new StallWatchdog(() => {
        this.stats.stalls = (this.stats.stalls || 0) + 1;
        this.emit("warning", { source: "token2022-traps", message: "stream went quiet, reconnecting" });
        dropSocket(ws);
      }).start();
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PROGRAMS.TOKEN_2022] }, { commitment: "confirmed" }] }));
    };
    ws.onmessage = (ev) => {
      try {
        this.#onMessage(ev);
      } catch (e) {
        this.emit("warning", { source: "token2022-traps", message: `message skipped: ${e.message}` });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.stats.connected = false;
      this.dog?.stop();
      this.emit("status", { source: "token2022-traps", connected: false });
      if (this.stopped) return;
      // Plans without WebSocket access (e.g. Solami Free) refuse the upgrade: use the fallback.
      if (!opened && ++this.failedOpens >= 2 && this.fallbackUrl && this.wsUrl !== this.fallbackUrl) {
        this.wsUrl = this.fallbackUrl;
        this.attempt = 0;
        this.emit("warning", { source: "token2022-traps", message: "WebSocket refused (plan without WS access?); switching to the fallback endpoint" });
      }
      this.stats.reconnects++;
      setTimeout(() => this.#connect(), Math.min(30000, 1000 * 2 ** this.attempt++));
    };
  }
}
