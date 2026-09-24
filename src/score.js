// Explainable risk scoring. Pure function: report in, { score, level, flags, positives } out.
// Every flag says what was found and what it means for a buyer, in plain English.

const WELL_KNOWN = new Map([
  ["USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  ["USDT", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"],
  ["SOL", "So11111111111111111111111111111111111111112"],
  ["WSOL", "So11111111111111111111111111111111111111112"],
  ["JUP", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"],
  ["BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
  ["WIF", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"],
  ["PYTH", "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3"],
  ["JTO", "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"],
  ["RAY", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"],
  ["PUMP", "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"],
  ["TRUMP", "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN"],
  ["PYUSD", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"],
]);

// Official mints of well-known assets: their authorities are held by the issuer on purpose.
const OFFICIAL = new Set([...WELL_KNOWN.values()]);

// Brands and liquid-staking tokens that scammers copy by name.
const BRANDS = ["USDC", "USDT", "PYUSD", "JITOSOL", "MSOL", "BSOL", "JUPSOL", "EDGESOL", "PHANTOM", "BINANCE", "COINBASE", "TETHER"];

// Latin look-alikes from Cyrillic and Greek, used to fake names like "BITCОIN". Only a word that
// mixes scripts counts: an all-Greek name with a Latin ticker ("ΛΥΣΙΟΣ" / "LYSIOS") is fine.
const HOMOGLYPH = /[\u0400-\u04FF\u0370-\u03FF]/;
const LATIN = /[A-Za-z]/;
export const mixesScripts = (label) => label.split(/[^\p{L}\p{N}]+/u).some((w) => HOMOGLYPH.test(w) && LATIN.test(w));

// Lures: tokens named like a giveaway or carrying a link, used to send people to wallet drainers.
const BAIT_WORDS = /\bGIVE\s?AWAYS?\b|\bFREE\s*\d*\s*(SOL|USDC|USDT|CRYPTO|MONEY|TOKENS?)\b|\bAIRDROP\b|\bCLAIM\b/i;
const BAIT_LINK = /https?:\/\/|www\.|t\.me\/|\b[a-z0-9-]{2,}\.(com|io|xyz|app|net|org|gg|site|online|live|vip)\b/i;

// Powers held by a program address count for less than powers held by a personal wallet.
const PROGRAM_DISCOUNT = 0.4;

const LEVELS = [
  [70, "CRITICAL"],
  [45, "HIGH"],
  [20, "MEDIUM"],
  [0, "LOW"],
];

export function scoreReport(r, ctx = {}) {
  const flags = [];
  const positives = [];
  const add = (points, id, text) => flags.push({ id, points, text });
  const t = r.token;
  const ext = t.extensions || {};

  // --- authorities
  if (t.mintAuthority) add(35, "mint_authority", "Mint authority is still active: the creator can print unlimited new tokens and dump them.");
  else positives.push("Mint authority revoked (supply is fixed).");
  if (t.freezeAuthority) add(30, "freeze_authority", "Freeze authority is still active: the creator can freeze your tokens so you can't sell.");
  else positives.push("Freeze authority revoked.");

  // --- Token-2022 extensions that can trap buyers
  if (ext.permanentDelegate?.delegate) add(40, "permanent_delegate", `Permanent delegate ${short(ext.permanentDelegate.delegate)} can move or burn tokens from ANY holder's wallet.`);
  if (ext.nonTransferable) add(40, "non_transferable", "Token is non-transferable: you cannot sell or send it.");
  if (ext.defaultAccountState && /frozen/i.test(String(ext.defaultAccountState.accountState))) add(35, "default_frozen", "New token accounts start frozen: buyers can be locked out of selling.");
  if (ext.pausableConfig?.authority) add(30, "pausable", "Transfers can be paused by an authority at any time.");
  if (ext.transferHook?.programId) add(25, "transfer_hook", `Every transfer runs custom program ${short(ext.transferHook.programId)}, which can block or tax sells.`);
  const fee = ext.transferFeeConfig;
  if (fee) {
    const bps = Math.max(Number(fee.newerTransferFee?.transferFeeBasisPoints ?? 0), Number(fee.olderTransferFee?.transferFeeBasisPoints ?? 0));
    if (bps > 0) add(Math.min(30, Math.ceil(bps / 100) * 10), "transfer_fee", `Transfer fee of ${(bps / 100).toFixed(2)}% on every transfer (including sells).`);
    if (fee.transferFeeConfigAuthority) add(10, "fee_authority", "The transfer fee can be raised later by its authority.");
  }
  if (ext.mintCloseAuthority?.closeAuthority) add(10, "mint_close", "The mint can be closed by an authority.");

  // --- metadata
  const md = r.metadata;
  if (md) {
    if (md.isMutable && md.updateAuthority) add(10, "mutable_metadata", "Name, symbol and image can still be changed by the creator.");
    else positives.push("Metadata is immutable.");
    const sym = (md.symbol || "").trim().toUpperCase().replace(/^\$/, "");
    const real = WELL_KNOWN.get(sym);
    if (real && real !== r.mint) add(40, "impersonation", `Uses the symbol ${sym} but is NOT the real ${sym} (${short(real)}): likely an impersonation.`);
  } else {
    add(5, "no_metadata", "No token metadata found.");
  }

  // --- concentration (pools and bonding curves excluded)
  const holders = (r.holders || []).filter((h) => !h.pool);
  if (holders.length) {
    const top = holders[0].pct;
    const top10 = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
    if (top >= 50) add(30, "top_holder", `One wallet holds ${top.toFixed(1)}% of supply.`);
    else if (top >= 20) add(15, "top_holder", `One wallet holds ${top.toFixed(1)}% of supply.`);
    if (top10 >= 50) add(15, "top10", `Top 10 wallets (excluding pools and program accounts) hold ${top10.toFixed(1)}% of supply.`);
    else positives.push(`Top 10 wallets (excluding pools and program accounts) hold ${top10.toFixed(1)}%.`);
  }
  const pooled = (r.holders || []).filter((h) => h.pool).reduce((s, h) => s + h.pct, 0);
  if (pooled > 0) positives.push(`${pooled.toFixed(1)}% of supply sits in pools, curves or other program accounts.`);

  // --- creator
  if (r.creator?.pct !== undefined) {
    if (r.creator.pct >= 30) add(20, "creator_holds", `Creator wallet still holds ${r.creator.pct.toFixed(1)}% of supply.`);
    else if (r.creator.pct >= 10) add(10, "creator_holds", `Creator wallet holds ${r.creator.pct.toFixed(1)}% of supply.`);
  }

  // --- look-alike characters and brand copying (on the name/symbol shown to buyers)
  const label = `${r.metadata?.name || ""} ${r.metadata?.symbol || ""}`;
  if (mixesScripts(label)) {
    add(35, "homoglyph", "Name/symbol mixes Latin letters with look-alike Cyrillic/Greek characters, a common impersonation trick.");
  }
  const squashed = label.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const brand = BRANDS.find((b) => squashed.includes(b));
  if (brand && !OFFICIAL.has(r.mint) && !flags.some((f) => f.id === "impersonation")) {
    add(15, "brand_copy", `Name/symbol contains "${brand}" but this is not an official ${brand} token.`);
  }

  if (BAIT_LINK.test(label)) add(25, "bait", "Name/symbol contains a link: a common lure to phishing or wallet-drainer sites.");
  else if (BAIT_WORDS.test(label)) add(20, "bait", "Name/symbol promises free money (giveaway/airdrop/claim), a common lure to wallet-drainer sites.");

  // --- behaviour seen by the radar itself (only available in live mode)
  if (ctx.creatorLaunches >= 3) add(25, "serial_launcher", `Creator wallet launched ${ctx.creatorLaunches} tokens in the last hour (serial launcher).`);
  const cs = ctx.creatorSold;
  if (cs && cs.pct >= 50) add(35, "creator_dump", `Creator already sold ${Math.round(cs.pct)}% of their tokens, ${fmtAge(cs.afterSec)} after launch.`);
  else if (cs && cs.pct >= 20) add(15, "creator_dump", `Creator has started selling (${Math.round(cs.pct)}% of their tokens, ${fmtAge(cs.afterSec)} after launch).`);
  const cm = ctx.creatorMoved;
  if (cm && cm.pct >= 50) add(20, "creator_transfer", `Creator moved ${Math.round(cm.pct)}% of their tokens to other wallets, ${fmtAge(cm.afterSec)} after launch (a common way to hide a dump).`);
  const lp = ctx.liquidityPulled;
  if (lp) add(40, "liquidity_pulled", `Creator removed $${Math.round(lp.usd).toLocaleString("en-US")} of liquidity from the pool, ${fmtAge(lp.afterSec)} after launch.`);
  if (ctx.sameNameLaunches >= 2) add(10, "copycat", `${ctx.sameNameLaunches} other tokens with this name/symbol launched in the last hour (copycat wave).`);

  // --- who holds the powers: a personal wallet can act any time; a program address (PDA)
  // can only act by that program's rules (prediction-market shares, vault/LP tokens...).
  const notes = [];
  if (ctx.graduated) notes.push(`Graduated from ${ctx.graduated.launchpad || "its launchpad"} to a ${ctx.graduated.dex || "DEX"} pool.`);
  if (ctx.surge?.multiple) notes.push(`Volume surge: ${ctx.surge.multiple}x its baseline${ctx.surge.volumeUsd ? ` ($${Math.round(ctx.surge.volumeUsd).toLocaleString("en-US")} in ${Math.round((ctx.surge.windowSecs || 300) / 60)} min)` : ""}.`);
  const holderOf = r.authorities || {};
  const ctl = r.controllers || {};
  let programHeld = 0;
  let walletHeld = 0;
  for (const f of flags) {
    const c = ctl[holderOf[f.id]];
    if (!c) continue;
    f.controller = c.kind;
    f.holder = holderOf[f.id];
    if (c.kind === "program") {
      programHeld++;
      f.program = c.program;
      f.points = Math.round(f.points * PROGRAM_DISCOUNT);
      f.text += ` Held by a program${c.program ? ` (${short(c.program)})` : ""}, not a wallet.`;
    } else {
      walletHeld++;
      if (!f.text.includes(short(f.holder))) f.text += ` Held by wallet ${short(f.holder)}.`;
    }
  }
  const category = programHeld > 0 && walletHeld === 0 ? "protocol" : "launch";
  if (category === "protocol") {
    // Protocols mint many similar tokens (one per market); that's expected, not a warning sign.
    for (const id of ["serial_launcher", "copycat"]) {
      const i = flags.findIndex((f) => f.id === id);
      if (i >= 0) notes.push(`${flags.splice(i, 1)[0].text.replace(/ \((serial launcher|copycat wave)\)\.$/, ".")} Expected for a protocol creating markets.`);
    }
    notes.unshift("Protocol-issued token: every power over it is held by a program address, not a person's wallet (typical of prediction-market outcome tokens and vault/LP shares). Lower risk, but only as safe as that program's rules.");
  }

  if (OFFICIAL.has(r.mint)) {
    // Official assets: controls are held by the issuer on purpose. Still worth knowing.
    const sym = [...WELL_KNOWN].find(([, m]) => m === r.mint)?.[0];
    const issuer = flags.filter((f) => f.id !== "brand_copy" && f.id !== "impersonation").map((f) => `Issuer control: ${f.text}`);
    return { score: 0, level: "KNOWN", category: "official", flags: [], notes: issuer, positives: [`Official ${sym} mint (well-known asset).`, ...positives] };
  }

  const score = Math.min(100, flags.reduce((s, f) => s + f.points, 0));
  const level = LEVELS.find(([min]) => score >= min)[1];
  flags.sort((a, b) => b.points - a.points);
  return { score, level, category, flags, notes, positives };
}

function fmtAge(sec) {
  return sec < 90 ? `${Math.max(0, Math.round(sec))}s` : `${Math.round(sec / 60)} min`;
}

function short(k) {
  return k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "?";
}
