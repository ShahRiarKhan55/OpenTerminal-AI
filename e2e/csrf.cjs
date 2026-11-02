// Attacker simulation: a page on ANOTHER origin tries to change state through the dashboard's proxy.
// Passes only if every vector fails and the open paper position is untouched. Needs the seeded demo stack.
const { chromium } = require("playwright");
const http = require("http");
const TARGET = process.env.E2E_WEB || "http://127.0.0.1:3010";
const EVIL_PORT = Number(process.env.E2E_EVIL_PORT || 3999);
const evil = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url === "/form") {
    res.end(`<form id=f method=POST action="${TARGET}/api/paper/positions/3/close"><input name=x value=1></form><script>document.getElementById('f').submit()</script>`);
  } else {
    res.end(`<script>
      const out = {};
      (async () => {
        try { await fetch("${TARGET}/api/paper/positions/3/close", { method: "POST", mode: "no-cors", body: "x" }); out.noCors = "sent (opaque)"; } catch (e) { out.noCors = "blocked"; }
        try { await fetch("${TARGET}/api/paper/positions/3/close", { method: "POST", headers: { "X-Requested-With": "openterminal" } }); out.withHeader = "sent"; } catch (e) { out.withHeader = "blocked by browser (CORS preflight)"; }
        try { const r = await fetch("${TARGET}/api/paper/account"); out.readBack = "status " + r.status; } catch (e) { out.readBack = "cannot read response (CORS)"; }
        document.title = JSON.stringify(out);
      })();
    </script>`);
  }
});
evil.listen(EVIL_PORT, "localhost", async () => {
  const state = async () => (await (await fetch(TARGET + "/api/paper/positions?status=open")).json()).length;
  const before = await state();
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://localhost:${EVIL_PORT}/form`, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(1500);
  const formBody = await page.locator("body").innerText().catch(() => "");
  await page.goto(`http://localhost:${EVIL_PORT}/fetch`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const title = await page.title();
  await browser.close();
  const after = await state();
  const noCors = /"withHeader":"blocked/.test(title) && /"readBack":"cannot read/.test(title);
  const formRefused = /anti-CSRF/.test(formBody);
  console.log("cross-site form POST ->", JSON.stringify(formBody.slice(0, 80)));
  console.log("cross-site fetch     ->", title);
  const ok = before === after && before >= 1 && noCors && formRefused;
  console.log(`open paper positions before=${before} after=${after}: ${ok ? "ATTACK FAILED on every vector (PASS)" : "FAIL"}`);
  evil.close();
  process.exit(ok ? 0 : 1);
});
