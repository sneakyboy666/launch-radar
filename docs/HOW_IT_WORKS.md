# How Launch Radar works (plain English)

## The one-sentence pitch
Launch Radar watches every new Solana token the moment it's created, checks it on-chain for the
tricks scammers use, and tells you in plain English what's dangerous, within seconds.

## The problem
Launching a token on Solana is free and instant, so hundreds launch every hour. Buyers can't
read smart-contract settings, and scammers know it. Common traps:
1. **Mint authority left on**: the creator can print more tokens and dump them on you.
2. **Freeze authority left on**: the creator can freeze your tokens so you can't sell.
3. **Token-2022 "extensions"**: Solana's newer token program lets a creator add powers like a
   *permanent delegate* (can take tokens out of anyone's wallet), *transfer fees* (a tax on every
   sale, sometimes changeable later), *transfer hooks* (custom code that can block sells),
   *default-frozen accounts* or *pausable* transfers.
4. **Impersonation**: a token called "USDC" that isn't USDC, or "BITCОIN" written with a Russian
   letter О that looks identical.
5. **Concentration**: one wallet holding most of the supply (after excluding the pool itself).
6. **Serial launchers and copycats**: the same wallet launching token after token, or ten copies
   of whatever name is trending. (Live example: one wallet launched 15 "FREE 1 SOL / 1 SOL
   GIVEAWAY" tokens in 5 minutes.)
7. **Bait**: names promising free money or containing a link, which lure people to fake "claim"
   sites that drain wallets.

## How it catches new tokens (the "sources")
- **Pump.fun feed**: we subscribe to Pump.fun's program logs over a WebSocket. When a token is
  created, Pump.fun writes a "CreateEvent" into the logs; we decode it directly (name, symbol,
  mint, creator), so detecting a launch costs zero extra requests. Every buy and sell also writes a
  "TradeEvent" (who, buy or sell, how much SOL, how many tokens), which we decode too. That's how
  we see the creator selling their tokens seconds after launch, and how the token's score goes up
  live when they do.
- **Token-2022 trap watch**: we subscribe to the Token-2022 program's logs (~900 messages a
  second). We only react when a new mint is created *and* one of the dangerous extensions is set
  up in the same transaction. That's rare, so it stays cheap.
- **Solami Blur**: Solami's decoded market data stream. We use its trades to show buy/sell
  counts, volume, unique wallets and "buy pressure" per token.

## How it checks a token (the "analysis")
For each new token we ask Solana (through Solami's RPC):
- the mint account → mint/freeze authority, supply, Token-2022 extensions;
- the metadata account → name, symbol, whether it can still be edited. For normal tokens that
  account lives at a special derived address ("PDA"); we compute it ourselves with the same math
  Solana uses (verified against the real USDC metadata account);
- the 20 largest holder accounts, and who owns them → so we can tell a real whale from the
  Pump.fun bonding curve or a Raydium pool (those are excluded from concentration);
- who holds each power → every Solana address is either a normal key (on the ed25519 curve:
  someone holds the private key and can act any time) or a "program derived address" (off the
  curve: nobody has a key, only its program can sign). We do that math locally, then look up which
  program owns it;
- the first transaction → who created it, and how much they still hold.

## How the score works
Every finding adds points and a sentence, for example "Freeze authority is still active: the
creator can freeze your tokens so you can't sell (+30)". Total points → LOW (0–19), MEDIUM (20–44),
HIGH (45–69), CRITICAL (70+). Nothing is hidden: the dashboard shows every reason. Powers held by a program instead of a
wallet count for 40% of the points, and if *every* power is program-held the token is labeled
**protocol** (e.g. prediction-market "BTC Up/Down" shares, which launch every few minutes) and kept
out of alerts and scam stats. We found these in our own soak test: they were ~25% of all
"CRITICAL" results before this fix. Official assets
(USDC, USDT, PYUSD…) are shown as KNOWN, with their issuer controls listed as information.

## Does the score predict a dump?
We checked, and the honest answer is no. For every token we remember the red flags it had at
launch (before any selling), then watch whether its creator sells at least half their tokens. In a
15-minute live run (432 launches), tokens with no red flags were dumped 56% of the time, serial
launchers 52%, copycats 34%. So a launch-time score can't tell you whether a memecoin creator will
dump; about half do. That is why the radar watches the creator live and raises the score within
seconds when they sell, move tokens out, or pull liquidity. The static checks answer a different
question: what the creator is still *able* to do (mint, freeze, take tokens back, tax sells).

## Why Solami matters here
- Full analysis of every launch needs lots of requests quickly; Solami Pro gives 200 requests/sec.
  On the free public RPC the radar has to run in "light mode" (skipping holders and creator).
- One key covers RPC, WebSockets and Blur market data, so the whole tool runs on one provider.

## What it is NOT
Not a trading bot and not financial advice. A LOW score only means none of these traps were found.

## Tech in one paragraph
Node.js with zero dependencies. `solana.js` (address math + RPC client with rate limiting and
retries), `token.js` (collects on-chain facts), `score.js` (turns facts into explained points),
`sources/` (Pump.fun, Token-2022, Blur), `radar.js` (queue + live metrics), `server.js` +
`web/index.html` (dashboard via Server-Sent Events), `cli.js` (check / watch / discover).
14 unit tests run offline with `npm test`.
