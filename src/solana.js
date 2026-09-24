// Minimal, dependency-free Solana helpers: base58, PDA derivation, JSON-RPC client.
import { createHash } from "node:crypto";

// ---------------------------------------------------------------- base58
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = INDEX[c];
    if (v === undefined) throw new Error(`invalid base58 character: ${c}`);
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function isValidPubkey(str) {
  try {
    return typeof str === "string" && base58Decode(str).length === 32;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- ed25519 on-curve check
// A PDA must NOT be a valid ed25519 point. Mirrors curve25519-dalek decompress(): the
// y-coordinate is valid iff (y^2 - 1) / (d*y^2 + 1) is a square mod p.
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;

function mod(a) {
  const r = a % P;
  return r >= 0n ? r : r + P;
}
function modPow(base, exp) {
  let result = 1n;
  base = mod(base);
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % P;
    base = (base * base) % P;
    exp >>= 1n;
  }
  return result;
}
function modInv(a) {
  return modPow(((a % P) + P) % P, P - 2n);
}

export function isOnCurve(bytes32) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes32[i]);
  y &= (1n << 255n) - 1n; // drop the sign bit
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = (u * modInv(v)) % P;
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n; // Euler's criterion
}

export function findProgramAddress(seeds, programId) {
  const program = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update(Buffer.from("ProgramDerivedAddress"));
    const candidate = new Uint8Array(h.digest());
    if (!isOnCurve(candidate)) return [base58Encode(candidate), bump];
  }
  throw new Error("no viable bump seed");
}

export const PROGRAMS = {
  TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  METADATA: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMP_AMM: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  RAYDIUM_AMM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  RAYDIUM_CPMM: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  RAYDIUM_LAUNCHLAB: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  METEORA_DBC: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  METEORA_DAMM_V2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
};

export function metadataPda(mint) {
  return findProgramAddress(
    [Buffer.from("metadata"), base58Decode(PROGRAMS.METADATA), base58Decode(mint)],
    PROGRAMS.METADATA,
  )[0];
}

// ---------------------------------------------------------------- JSON-RPC client
export class Rpc {
  constructor(url, { maxConcurrent = 4, minIntervalMs = 0, timeoutMs = 15000 } = {}) {
    this.url = url;
    this.maxConcurrent = maxConcurrent;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.queue = [];
    this.lastStart = 0;
    this.id = 0;
    this.baseIntervalMs = minIntervalMs;
    this.okStreak = 0;
    this.stats = { requests: 0, errors: 0, retries: 0, throttled: 0, totalLatencyMs: 0, lastError: null };
  }

  // Adaptive pacing: plans differ (Solami Free is 5 req/s, Pro 200), so back off on HTTP 429
  // and creep back toward full speed after a run of successes.
  #throttle(retryAfterSec) {
    this.stats.throttled++;
    this.okStreak = 0;
    this.minIntervalMs = Math.min(2000, Math.max(this.minIntervalMs * 2, 220, (retryAfterSec || 0) * 1000));
  }
  #ok() {
    if (++this.okStreak >= 40 && this.minIntervalMs > this.baseIntervalMs) {
      this.minIntervalMs = Math.max(this.baseIntervalMs, Math.floor(this.minIntervalMs * 0.8));
      this.okStreak = 0;
    }
  }

  async #slot() {
    while (this.active >= this.maxConcurrent) await new Promise((r) => this.queue.push(r));
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastStart = Date.now();
    this.active++;
  }
  #release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async call(method, params = [], { retries = 4, timeoutMs = this.timeoutMs } = {}) {
    for (let attempt = 0; ; attempt++) {
      await this.#slot();
      const started = Date.now();
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        this.stats.requests++;
        this.stats.totalLatencyMs += Date.now() - started;
        if (res.status === 429) this.#throttle(Number(res.headers.get("retry-after")) || 0);
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
        const body = await res.json();
        if (body.error) {
          const retryable = body.error.code === -32005 || /rate|limit|busy/i.test(body.error.message || "");
          if (retryable) this.#throttle(0);
          throw Object.assign(new Error(`${method}: ${body.error.message}`), { retryable, code: body.error.code });
        }
        this.#ok();
        return body.result;
      } catch (err) {
        this.stats.errors++;
        this.stats.lastError = err.message;
        const retryable = err.retryable || err.name === "TimeoutError" || err.name === "TypeError";
        if (!retryable || attempt >= retries) throw err;
        this.stats.retries++;
        await new Promise((r) => setTimeout(r, Math.min(8000, 400 * 2 ** attempt) + Math.random() * 200));
      } finally {
        this.#release();
      }
    }
  }

  intervalMs() {
    return this.minIntervalMs;
  }

  avgLatencyMs() {
    return this.stats.requests ? Math.round(this.stats.totalLatencyMs / this.stats.requests) : null;
  }
}
