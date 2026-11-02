import express, { Router } from "express";
import cors from "cors";
import { marketRouter } from "./routes/market.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { aiRouter } from "./routes/ai.js";
import { allStats } from "./providers/registry.js";
import { requireApiKey } from "./auth.js";
import { rateLimit } from "./rateLimit.js";
import { summarize } from "./marketdata/ledger.js";
import { tradingRouter, TRADING_PREFIXES } from "./routes/trading.js";
import { freshnessPolicyFromEnv } from "./marketdata/freshness.js";

export function createApp() {
const app = express();

// Off by default: req.ip then falls back to the immediate socket address
// (the bundled web proxy's own address when called through it), so every
// caller behind that proxy shares one rate-limit bucket — safe, if coarser
// than per-browser. Only set TRUST_PROXY=1 if you know exactly one trusted
// reverse proxy sits in front of this process (the bundled web proxy alone,
// or your own proxy in front of it that itself sets X-Forwarded-For from
// the real client and doesn't let callers inject their own value) —
// otherwise a caller can forge X-Forwarded-For to dodge the rate limit.
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

// Only the configured web origin may call this API from a browser. Without
// this, any website open in the same browser as the terminal could reach a
// server bound beyond localhost — cors() with no options reflects every
// origin.
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
app.use(cors({ origin: webOrigin }));
app.use(express.json());

// No API key here by design (market.ts routes proxy free, keyless public data),
// but still bounded per-IP: unlike /api/ai and /api/portfolios, an unauthenticated
// caller could otherwise repeat the multi-provider fan-out in market.ts (up to
// hundreds of outbound calls per request — see getQuotes) fast enough to get
// this deployment's IP rate-limited or banned by Nasdaq/Yahoo/Stooq/SEC.
app.use("/api", rateLimit({ windowMs: 60_000, max: 240 }), marketRouter);
// Monitoring engine (watchlists, alerts, signals, paper trading, risk, reports, audit): every route
// requires the shared secret and is rate limited per caller. The guard only engages for these
// prefixes, so the keyless market-data routes above are unaffected. See routes/trading.ts.
const guardedTrading = Router();
guardedTrading.use(requireApiKey, rateLimit({ windowMs: 60_000, max: 300 }), tradingRouter);
app.use("/api", (req, res, next) => {
  if (TRADING_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"))) return guardedTrading(req, res, next);
  next();
});
// Portfolio data and the paid AI endpoint require a shared secret; see auth.ts.
app.use("/api/portfolios", requireApiKey, portfolioRouter);
app.use(
  "/api/ai",
  requireApiKey,
  rateLimit({ windowMs: 60_000, max: 10 }),
  aiRouter
);

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    providers: allStats(),
    // Aggregate only: never lists symbols, so the unauthenticated status route
    // doesn't reveal what the user is watching.
    dataQuality: summarize(Date.now(), freshnessPolicyFromEnv()),
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

return app;
}
