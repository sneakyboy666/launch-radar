// Fetch everything needed to judge a token's safety, using plain Solana RPC calls.
import { base58Decode, base58Encode, isOnCurve, metadataPda, PROGRAMS } from "./solana.js";

// Programs whose accounts hold supply on behalf of a pool/curve (not a "whale").
export const POOL_PROGRAMS = new Map([
  [PROGRAMS.PUMP_FUN, "Pump.fun bonding curve"],
  [PROGRAMS.PUMP_AMM, "PumpSwap pool"],
  [PROGRAMS.RAYDIUM_AMM_V4, "Raydium AMM"],
  [PROGRAMS.RAYDIUM_CPMM, "Raydium CPMM"],
  [PROGRAMS.RAYDIUM_LAUNCHLAB, "Raydium LaunchLab curve"],
  [PROGRAMS.METEORA_DBC, "Meteora DBC curve"],
  [PROGRAMS.METEORA_DAMM_V2, "Meteora DAMM pool"],
  [PROGRAMS.ORCA_WHIRLPOOL, "Orca Whirlpool"],
]);

// Raydium AMM v4 pools use a single fixed authority wallet (not a PDA owned by the program).
const KNOWN_POOL_WALLETS = new Map([["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "Raydium AMM authority"]]);

// ---------------------------------------------------------------- Metaplex metadata (borsh)
export function parseMetaplexMetadata(buf) {
  let o = 0;
  const u8 = () => buf[o++];
  const pubkey = () => {
    const k = base58Encode(buf.subarray(o, o + 32));
    o += 32;
    return k;
  };
  const str = () => {
    const len = buf.readUInt32LE(o);
    o += 4;
    const s = buf.subarray(o, o + len).toString("utf8").replace(/\0+$/g, "").trim();
    o += len;
    return s;
  };
  const key = u8();
  if (key !== 4) throw new Error(`not a MetadataV1 account (key=${key})`);
  const updateAuthority = pubkey();
  const mint = pubkey();
  const name = str();
  const symbol = str();
  const uri = str();
  o += 2; // seller_fee_basis_points
  const creators = [];
  if (u8() === 1) {
    const n = buf.readUInt32LE(o);
    o += 4;
    for (let i = 0; i < n; i++) {
      const address = pubkey();
      const verified = u8() === 1;
      const share = u8();
      creators.push({ address, verified, share });
    }
  }
  const primarySaleHappened = u8() === 1;
  const isMutable = u8() === 1;
  return { updateAuthority, mint, name, symbol, uri, creators, primarySaleHappened, isMutable };
}

// ---------------------------------------------------------------- mint
export function summarizeMint(parsedAccount) {
  const value = parsedAccount?.value;
  if (!value) return null;
  const program = value.owner;
  const info = value.data?.parsed?.info;
  if (!info || value.data?.parsed?.type !== "mint") return null;
  const ext = {};
  for (const e of info.extensions || []) ext[e.extension] = e.state ?? true;
  return {
    program: program === PROGRAMS.TOKEN_2022 ? "token-2022" : program === PROGRAMS.TOKEN ? "spl-token" : program,
    decimals: info.decimals,
    supply: BigInt(info.supply),
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    extensions: ext,
  };
}

// Every address that holds a power over the token, keyed by what it can do.
export function authorityAddresses(m, metadata) {
  const e = m.extensions || {};
  const out = {
    mint_authority: m.mintAuthority,
    freeze_authority: m.freezeAuthority,
    permanent_delegate: e.permanentDelegate?.delegate,
    pausable: e.pausableConfig?.authority,
    fee_authority: e.transferFeeConfig?.transferFeeConfigAuthority,
    mint_close: e.mintCloseAuthority?.closeAuthority,
    mutable_metadata: metadata?.isMutable ? metadata.updateAuthority : null,
  };
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

// Wallet (a key someone holds, can act any time) or program address (PDA: only the owning
// program can sign, e.g. a prediction market settling its outcome tokens).
export async function classifyControllers(rpc, addresses) {
  const unique = [...new Set(addresses)];
  const result = {};
  const pdas = [];
  for (const a of unique) {
    let onCurve = true;
    try {
      onCurve = isOnCurve(base58Decode(a));
    } catch {}
    result[a] = { kind: onCurve ? "wallet" : "program", program: null };
    if (!onCurve) pdas.push(a);
  }
  if (pdas.length) {
    const accs = await rpc.call("getMultipleAccounts", [pdas, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]);
    pdas.forEach((a, i) => (result[a].program = accs?.value?.[i]?.owner ?? null));
  }
  return result;
}

// ---------------------------------------------------------------- analysis
export async function analyzeToken(rpc, mint, { withCreator = true, withHolders = true, knownCreator = null } = {}) {
  const started = Date.now();
  const report = { mint, checkedAt: new Date().toISOString(), errors: [] };

  const mintAcc = await rpc.call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const m = summarizeMint(mintAcc);
  if (!m) throw new Error(`${mint} is not a token mint`);
  report.token = m;

  // Metadata: Token-2022 embedded metadata, else Metaplex metadata account.
  const embedded = m.extensions.tokenMetadata;
  if (embedded) {
    report.metadata = {
      source: "token-2022",
      name: embedded.name,
      symbol: embedded.symbol,
      uri: embedded.uri,
      updateAuthority: embedded.updateAuthority ?? null,
      isMutable: Boolean(embedded.updateAuthority),
    };
  } else {
    try {
      const md = await rpc.call("getAccountInfo", [metadataPda(mint), { encoding: "base64", commitment: "confirmed" }]);
      if (md?.value) {
        const parsed = parseMetaplexMetadata(Buffer.from(md.value.data[0], "base64"));
        report.metadata = { source: "metaplex", ...parsed };
      }
    } catch (e) {
      report.errors.push(`metadata: ${e.message}`);
    }
  }

  // Who holds each power: a wallet, or a program (PDA)?
  report.authorities = authorityAddresses(m, report.metadata);
  if (Object.keys(report.authorities).length) {
    try {
      report.controllers = await classifyControllers(rpc, Object.values(report.authorities));
    } catch (e) {
      report.errors.push(`controllers: ${e.message}`);
    }
  }

  // Holders: largest token accounts -> their owners -> is the owner a pool/curve?
  if (withHolders) try {
    const largest = await rpc.call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    const accounts = (largest?.value || []).filter((a) => BigInt(a.amount) > 0n);
    // Owner = bytes 32..64 of any SPL / Token-2022 token account. Read raw so it works on every
    // RPC (some don't return jsonParsed from getMultipleAccounts).
    const tokenAccs = accounts.length
      ? await rpc.call("getMultipleAccounts", [accounts.map((a) => a.address), { encoding: "base64", dataSlice: { offset: 32, length: 32 }, commitment: "confirmed" }])
      : { value: [] };
    const owners = tokenAccs.value.map((v) => (v?.data?.[0] ? base58Encode(Buffer.from(v.data[0], "base64")) : null));
    const ownerAccs = owners.filter(Boolean).length
      ? await rpc.call("getMultipleAccounts", [owners.map((o) => o || PROGRAMS.TOKEN), { encoding: "base64", commitment: "confirmed" }])
      : { value: [] };
    const supply = m.supply > 0n ? m.supply : 1n;
    report.holders = accounts.map((a, i) => {
      const owner = owners[i];
      const ownerProgram = ownerAccs.value[i]?.owner ?? null;
      // Owners off the ed25519 curve are program addresses (curves, pool vaults, launchpad
      // agents): no person holds a key, so they don't count as whales.
      let pda = false;
      try {
        pda = Boolean(owner) && !isOnCurve(base58Decode(owner));
      } catch {}
      const poolLabel = KNOWN_POOL_WALLETS.get(owner) || POOL_PROGRAMS.get(ownerProgram) || (pda ? "program account" : null);
      return {
        tokenAccount: a.address,
        owner,
        amount: BigInt(a.amount),
        pct: Number((BigInt(a.amount) * 1000000n) / supply) / 10000,
        pool: poolLabel,
      };
    });
  } catch (e) {
    report.errors.push(`holders: ${e.message}`);
  }

  // Creator: known from the launch event when we saw it launch; otherwise the fee payer of the
  // earliest transaction touching the mint. Paged 100 at a time (some RPCs stall on limit 1000);
  // a mint with more than 500 transactions is not a new launch, so we stop there.
  if (knownCreator) {
    report.creator = { address: knownCreator, source: "launch event" };
  } else if (withCreator) {
    try {
      let before;
      let oldest = null;
      let count = 0;
      for (let page = 0; page < 5; page++) {
        // Optional detail: keep it from stalling a check (some RPCs are slow on this method).
        const sigs = await rpc.call("getSignaturesForAddress", [mint, { limit: 100, before, commitment: "confirmed" }], { retries: 1, timeoutMs: 6000 });
        count += sigs.length;
        if (sigs.length) oldest = sigs[sigs.length - 1];
        if (sigs.length < 100) {
          before = null;
          break;
        }
        before = oldest.signature;
      }
      if (oldest && !before) {
        const tx = await rpc.call("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
        const payer = tx?.transaction?.message?.accountKeys?.find((k) => k.signer)?.pubkey ?? null;
        report.creator = { address: payer, firstSignature: oldest.signature, createdAt: oldest.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : null, txCount: count, source: "first transaction" };
      }
    } catch (e) {
      report.errors.push(`creator: ${e.message}`);
    }
  }
  if (report.creator?.address && report.holders) {
    report.creator.pct = report.holders.filter((h) => h.owner === report.creator.address).reduce((s, h) => s + h.pct, 0);
  }

  report.ms = Date.now() - started;
  return report;
}
