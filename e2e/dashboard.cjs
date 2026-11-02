// Browser acceptance test for the dashboard against a running stack seeded with demo data.
// Run through e2e/run.sh (it starts the stack on scratch data); see docs/OPERATIONS.md.
const { chromium } = require("playwright");
const fs = require("fs");
const OUT = process.argv[2];
const WEB = process.env.E2E_WEB || "http://127.0.0.1:3010";
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok: !!ok }); console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  -> " + extra : "")); };
const api = async (path, init) => { const r = await fetch(WEB + path, init); const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, j: t }; } };

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
  const page = await ctx.newPage();
  const errors = [], bad = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("response", (r) => { if (r.status() >= 500 && r.url().includes("/api/")) bad.push(r.status() + " " + r.url()); });

  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("DAY TRADER LAYOUT").click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: OUT + "/dashboard.png" });
  const text = async () => (await page.locator("body").innerText());
  let t = await text();

  check("Top bar shows PAPER mode badge", /PAPER/.test(t));
  check("Top bar shows monitor running", /MON ●/.test(t));
  check("Top bar shows unread alert count", /▲\s*\d+/.test(t));
  check("Alerts widget lists seeded alerts", /\[DEMO\] AAPL BREAKOUT20 long setup/.test(t));
  check("AI note displayed and labelled", /AI\s*Breakout above the 20-day high/.test(t));
  check("Data-quality label on alert", /data: provider-reported real-time · 8s old · nasdaq/.test(t));
  check("Paper widget shows paper-only banner", /no real orders exist/.test(t));
  check("Paper tiles: equity & day P&L", /EQUITY/i.test(t) && /DAY P&L/i.test(t));
  check("Open AAPL position with live P&L", /AAPL\s+95\s+231\.50\s+233\.20/.test(t.replace(/\n+/g, " ")), "");
  check("Monitor shows worker running", /WORKER RUNNING/.test(t));
  check("Monitor shows risk-on regime", /RISK-ON/.test(t));
  check("Monitor shows AI budget", /3\/10 calls today/.test(t));
  check("Monitor shows Telegram configured", /configured/.test(t));

  // engine isn't leaking secrets into the page
  const html = await page.content();
  check("No API key in page HTML", !html.includes(process.env.E2E_API_KEY || "e2ekey"));
  const storage = await page.evaluate(() => JSON.stringify({ l: { ...localStorage } }));
  check("No API key in localStorage", !storage.includes(process.env.E2E_API_KEY || "e2ekey"));

  // signals tab
  await page.getByRole("button", { name: "SIGNALS" }).click();
  await page.waitForTimeout(1500);
  t = await text();
  check("Signals tab shows blocked MSFT with status", /MSFT[\s\S]*blocked/.test(t));
  await page.getByRole("button", { name: /^ALERTS/ }).first().click();

  // ack all
  const before = (await api("/api/alerts?limit=1")).j.unacknowledgedImportant;
  await page.getByRole("button", { name: "ACK ALL" }).click();
  await page.waitForTimeout(1500);
  const after = (await api("/api/alerts?limit=1")).j.unacknowledgedImportant;
  check("ACK ALL clears unread important alerts", before > 0 && after === 0, `${before} -> ${after}`);

  // watchlist: invalid + valid
  const wl = page.locator("input[placeholder='Add ticker…']");
  await wl.fill("^GSPC"); await wl.press("Enter");
  await page.waitForTimeout(500);
  t = await text();
  check("Watchlist rejects non-US-stock symbol with explanation", /not a US stock\/ETF ticker/.test(t));
  await wl.fill("amd"); await wl.press("Enter");
  await page.waitForTimeout(1500);
  const lists = (await api("/api/watchlists")).j;
  check("Valid symbol is saved to the SERVER watchlist", lists[0].symbols.includes("AMD"), lists[0].symbols.join(","));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  t = await text();
  check("Watchlist survives reload (server-backed)", /AMD/.test(t));

  // manual close of the open position
  await page.getByRole("button", { name: "close" }).first().click();
  await page.waitForTimeout(2000);
  const open = (await api("/api/paper/positions?status=open")).j;
  check("Manual close closes the paper position server-side", Array.isArray(open) && open.length === 0, JSON.stringify(open.length));
  const acct = (await api("/api/paper/account")).j;
  check("Account shows realised P&L after manual close", acct.openPositions === 0 && acct.allTime.closedTrades === 3, `closed=${acct.allTime.closedTrades}`);

  // monitor: kill switch + risk edit
  await page.getByRole("button", { name: "RISK" }).click();
  await page.getByRole("button", { name: /PAPER ENTRIES: ON/ }).click();
  await page.waitForTimeout(1500);
  check("Kill switch turns paper entries off", (await api("/api/risk/config")).j.config.tradingEnabled === false);
  await page.getByRole("button", { name: /PAPER ENTRIES: OFF/ }).click();
  await page.waitForTimeout(1200);
  check("Kill switch turns paper entries back on", (await api("/api/risk/config")).j.config.tradingEnabled === true);
  const risk = page.locator("label", { hasText: "Max open positions" }).locator("input");
  await risk.fill("2");
  await page.getByRole("button", { name: "SAVE" }).click();
  await page.waitForTimeout(1500);
  check("Risk limit edit persists", (await api("/api/risk/config")).j.config.maxOpenPositions === 2);
  await risk.fill("500");
  await page.getByRole("button", { name: "SAVE" }).click();
  await page.waitForTimeout(1200);
  t = await text();
  check("Out-of-bounds risk edit is refused with a message", /maxOpenPositions|Too big|less than or equal/i.test(t) && (await api("/api/risk/config")).j.config.maxOpenPositions === 2);
  await page.getByRole("button", { name: "REPORTS" }).click();
  await page.getByText("[DEMO] Daily report").click();
  await page.waitForTimeout(800);
  t = await text();
  check("Report opens and carries the simulated disclaimer", /All figures are SIMULATED/.test(t));

  await page.screenshot({ path: OUT + "/dashboard-after.png" });
  // The only expected browser-logged failure is the single deliberate out-of-bounds risk edit (HTTP 400).
  const unexpected = errors.filter((e) => !/status of 400/.test(e));
  const expected400 = errors.filter((e) => /status of 400/.test(e)).length;
  check("No uncaught page errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  check("Exactly one HTTP 400 (the deliberate out-of-bounds edit)", expected400 === 1, String(expected400));
  check("No 5xx API responses", bad.length === 0, bad.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(OUT + "/e2e-result.json", JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("E2E crashed:", e); process.exit(2); });
