// Local web server: live dashboard (Server-Sent Events) + JSON API.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeToken } from "./token.js";
import { scoreReport } from "./score.js";
import { isValidPubkey } from "./solana.js";

export function startServer({ cfg, radar, rpc, sources, alerts = null }) {
  const clients = new Set();
  const page = () => readFileSync(join(cfg.root, "web", "index.html"));
  const status = () => ({
    usingSolami: cfg.usingSolami,
    lightMode: cfg.lightMode,
    sources: Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, s.stats])),
    metrics: radar.metrics(),
    alerts: alerts?.stats() ?? null,
  });
  const push = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  radar.on("update", (v) => push("token", v));
  setInterval(() => push("status", status()), 2000).unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page());
      }
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: snapshot\ndata: ${JSON.stringify({ tokens: radar.list(100), status: status() })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/api/state") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: status(), tokens: radar.list(200) }));
      }
      if (url.pathname === "/api/check") {
        const mint = url.searchParams.get("mint") || "";
        if (!isValidPubkey(mint)) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid mint address" }));
        }
        const report = await analyzeToken(rpc, mint);
        const risk = scoreReport(report);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ mint, risk, report }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      }
      res.writeHead(404);
      res.end("not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(cfg.port, cfg.host);
  return server;
}
