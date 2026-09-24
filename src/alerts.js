// Webhook alerts for risky launches. Discord webhooks get a readable message; any other
// URL gets the raw JSON. Rate-limited so a burst of scams can't spam the channel.
export class Alerts {
  constructor(url, { minIntervalMs = 1500 } = {}) {
    this.url = url;
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.sent = 0;
    this.dropped = 0;
    this.failed = 0;
    this.lastStatus = null;
  }

  stats() {
    return { enabled: Boolean(this.url), sent: this.sent, dropped: this.dropped, failed: this.failed, lastStatus: this.lastStatus };
  }

  async send(view) {
    if (!this.url) return false;
    const now = Date.now();
    if (now - this.last < this.minIntervalMs) {
      this.dropped++;
      return false;
    }
    this.last = now;
    const isDiscord = /discord(app)?\.com\/api\/webhooks\//.test(this.url);
    const top = view.flags.slice(0, 3).map((f) => `• ${f.text}`).join("\n");
    const body = isDiscord
      ? { content: `**${view.level}** risk (${view.score}/100): **${view.symbol || "?"}** ${view.name ? `(${view.name})` : ""}\n${top}\nhttps://solscan.io/token/${view.mint}`.slice(0, 1900) }
      : { event: "launch_risk", ...view };
    try {
      const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      this.lastStatus = res.status;
      if (res.ok) this.sent++;
      else this.failed++;
      return res.ok;
    } catch (e) {
      this.failed++;
      this.lastStatus = e.name;
      return false;
    }
  }
}
