// Trap watch: catches every NEW Token-2022 mint that initializes an extension that can be
// used against buyers (permanent delegate, transfer fee, transfer hook, default-frozen
// accounts, non-transferable, pausable). Filters on program logs first, so only the rare
// risky mints cost an extra RPC call (getTransaction) to find the mint address.
import { EventEmitter } from "node:events";
import { PROGRAMS } from "../solana.js";

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

export function mintsFromParsedTx(tx) {
  const mints = new Set();
  const visit = (ix) => {
    const p = ix?.parsed;
    if (ix?.programId === PROGRAMS.TOKEN_2022 && p?.type && /^initializeMint2?$/.test(p.type) && p.info?.mint) mints.add(p.info.mint);
  };
  for (const ix of tx?.transaction?.message?.instructions || []) visit(ix);
  for (const inner of tx?.meta?.innerInstructions || []) for (const ix of inner.instructions || []) visit(ix);
  return [...mints];
}

export class Token2022TrapWatch extends EventEmitter {
  constructor(wsUrl, rpc) {
    super();
    this.wsUrl = wsUrl;
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
    this.ws?.close();
  }

  async #resolve(signature, extensions, slot) {
    try {
      const tx = await this.rpc.call("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const creator = tx?.transaction?.message?.accountKeys?.find((k) => k.signer)?.pubkey ?? null;
      for (const mint of mintsFromParsedTx(tx)) {
        if (this.seen.has(mint)) continue;
        this.seen.add(mint);
        this.emit("launch", { mint, name: "", symbol: "", creator, source: `token-2022: ${extensions.join(", ")}`, signature, slot, seenAt: Date.now() });
      }
    } catch (e) {
      this.emit("error", e);
    }
  }

  #connect() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.stats.connected = true;
      this.emit("status", { source: "token2022-traps", connected: true });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PROGRAMS.TOKEN_2022] }, { commitment: "confirmed" }] }));
    };
    ws.onmessage = (ev) => {
      this.stats.messages++;
      this.stats.lastMessageAt = Date.now();
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
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.stats.connected = false;
      this.emit("status", { source: "token2022-traps", connected: false });
      if (this.stopped) return;
      this.stats.reconnects++;
      setTimeout(() => this.#connect(), Math.min(30000, 1000 * 2 ** this.attempt++));
    };
  }
}
