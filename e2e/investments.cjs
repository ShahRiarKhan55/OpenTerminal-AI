// Browser acceptance test for the Personal Investment Command Center (/portfolio) against a running stack with an
// EMPTY holdings table. Manual NAV math is asserted exactly; the live BTC-JPY quote is accepted as LIVE or as the
// honest manual fallback (this must pass offline too).
const { chromium } = require("playwright");
const fs = require("fs");
const OUT = process.argv[2] || ".";
const WEB = process.env.E2E_WEB || "http://127.0.0.1:3010";
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  -> " + extra : "")); };
const api = async (path) => (await fetch(WEB + path)).json();

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("dialog", (d) => d.accept());
  const text = () => page.locator("body").innerText();
  const card = (name) => page.getByRole("article", { name });
  const money = async (cardLoc, label) => (await cardLoc.locator(`div:has(> div:text-is("${label}"))`).first().innerText()).replace(/\s+/g, " ");

  await page.goto(WEB + "/portfolio", { waitUntil: "domcontentloaded" });
  await page.getByText("Add your first holding").waitFor({ timeout: 20000 });
  let t = await text();
  check("Empty state explains manual NAV entry and offers presets", /enter the NAV/.test(t) && /eMAXIS Slim All Country/.test(t) && /Bitcoin \(BTC-JPY\)/.test(t));
  check("Empty portfolio shows no invented numbers (value is an em dash)", /TOTAL MARKET VALUE\s*\n?\s*—/i.test(t));
  check("Navigation: MY PORTFOLIO is highlighted, TERMINAL link present", (await page.getByRole("link", { name: "MY PORTFOLIO" }).getAttribute("aria-current")) === "page" && (await page.getByRole("link", { name: "TERMINAL" }).count()) === 1);

  // ---- 1. オルカン via preset
  await page.getByRole("button", { name: /\+ eMAXIS Slim All Country/ }).click();
  check("Preset opens the form, pre-filled with the 10,000-unit NAV basis", (await page.getByLabel("Name").inputValue()).includes("オルカン") && (await page.getByLabel("Prices are quoted").inputValue()) === "10000");
  check("Currency is fixed to JPY (selector disabled)", await page.getByLabel("Currency").isDisabled());
  await page.getByLabel("Units held").fill("１，２３４，５６７"); // full-width digits, as typed on a Japanese keyboard
  await page.getByLabel("Average purchase price (¥)").fill("25,000");
  await page.getByLabel("Current price / NAV (¥)").fill("28,000");
  t = await text();
  check("Live preview applies the 10,000 basis (cost ¥3,086,418, value ¥3,456,788)", /cost basis ¥3,086,418/.test(t) && /market value ¥3,456,788/.test(t));
  await page.getByRole("button", { name: "ADD HOLDING", exact: true }).click();
  const orukan = card(/eMAXIS Slim All Country/);
  await orukan.waitFor({ timeout: 10000 });
  check("オルカン card: market value ¥3,456,788", /¥3,456,788/.test(await money(orukan, "Market value")));
  check("オルカン card: cost basis ¥3,086,418", /¥3,086,418/.test(await money(orukan, "Cost basis")));
  const pl = await money(orukan, "Unrealized P/L");
  check("オルカン card: P/L +¥370,370 (+12.00%)", /\+¥370,370/.test(pl) && /\+12\.00%/.test(pl), pl);
  check("オルカン card: units shown exactly (1,234,567)", /1,234,567/.test(await money(orukan, "Units")));
  check("オルカン card: MANUAL badge and the NAV date stamp, in JST", /MANUAL/.test(await orukan.innerText()) && /JST/.test(await orukan.innerText()));
  t = await text();
  check("Totals now equal the one priced holding; allocation is 100%", /TOTAL MARKET VALUE\s*\n?\s*¥3,456,788/i.test(t) && /100\.0%/.test(t));

  // ---- 2. Gold Fund with NO price
  await page.getByRole("button", { name: "+ ADD HOLDING", exact: true }).click();
  await page.getByRole("button", { name: "Gold Fund", exact: true }).click();
  await page.getByLabel("Units held").fill("1,000,000");
  await page.getByLabel("Average purchase price (¥)").fill("20000");
  await page.getByRole("button", { name: "ADD HOLDING", exact: true }).click();
  const gold = card(/Gold Fund/);
  await gold.waitFor({ timeout: 10000 });
  t = await text();
  check("Unpriced Gold Fund shows NO PRICE and 'not valued' (never valued at cost)", /NO PRICE/.test(await gold.innerText()) && /not valued/.test(await gold.innerText()));
  check("Totals are flagged incomplete and exclude the unpriced holding", /Incomplete: some holdings have no price/.test(t) && /TOTAL MARKET VALUE\s*\n?\s*¥3,456,788/i.test(t) && /no price/.test(t));
  check("Invested cost still counts the unpriced holding (¥5,086,418)", /TOTAL INVESTED \(COST\)\s*\n?\s*¥5,086,418/i.test(t));

  // ---- 3. update Gold NAV inline
  await gold.getByRole("button", { name: "UPDATE NAV" }).click();
  await gold.getByLabel("New price or NAV").fill("19,000");
  await gold.getByRole("button", { name: "SAVE", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("¥1,900,000"), null, { timeout: 10000 });
  check("Gold NAV update: value ¥1,900,000, loss -¥100,000 (-5.00%)", /¥1,900,000/.test(await money(gold, "Market value")) && /-¥100,000/.test(await money(gold, "Unrealized P/L")) && /-5\.00%/.test(await money(gold, "Unrealized P/L")));
  t = await text();
  check("Portfolio totals: value ¥5,356,788, P/L +¥270,370 (+5.32%), no incomplete warning",
    /TOTAL MARKET VALUE\s*\n?\s*¥5,356,788/i.test(t) && /\+¥270,370/.test(t) && /\+5\.32%/.test(t) && !/Incomplete: some holdings/.test(t));
  const gAlloc = t.match(/Gold Fund\s+¥1,900,000\s+([\d.]+)%/);
  check("Allocation: オルカン 64.5% / Gold 35.5%", /64\.5%/.test(t) && !!gAlloc && gAlloc[1] === "35.5", gAlloc ? gAlloc[1] : "no match");

  // ---- 4. Bitcoin (live quote with manual fallback)
  await page.getByRole("button", { name: "+ ADD HOLDING", exact: true }).click();
  await page.getByRole("button", { name: /Bitcoin \(BTC-JPY\)/ }).click();
  check("Bitcoin preset: live-quote source and BTC-JPY symbol", (await page.getByLabel("Current price source").inputValue()) === "quote" && (await page.getByLabel(/^Symbol/).inputValue()) === "BTC-JPY");
  await page.getByLabel("Units held").fill("0.0123");
  await page.getByLabel("Average purchase price (¥)").fill("11,000,000");
  await page.getByLabel("Current price / NAV (¥)").fill("11,500,000");
  await page.getByRole("button", { name: "ADD HOLDING", exact: true }).click();
  const btc = card(/Bitcoin/);
  await btc.waitFor({ timeout: 10000 });
  await page.waitForTimeout(2500);
  const btcText = await btc.innerText();
  check("Bitcoin is priced honestly: LIVE quote, or MANUAL fallback (never stale/unpriced here)", /LIVE|MANUAL/.test(btcText) && !/NO PRICE|STALE/.test(btcText), btcText.split("\n").slice(0, 6).join(" | "));
  check("Fractional units shown exactly (0.0123)", /0\.0123/.test(await money(btc, "Units")));
  const prices = await api("/api/holdings");
  check("Server never stored a non-JPY holding", prices.holdings.every((h) => h.currency === "JPY"));

  // ---- 5. persistence
  await page.reload({ waitUntil: "domcontentloaded" });
  await card(/Bitcoin/).waitFor({ timeout: 20000 });
  check("After a full reload all three holdings are still there", (await page.getByRole("article").count()) === 3);
  check("Persisted values are unchanged after reload", /¥3,456,788/.test(await money(card(/eMAXIS/), "Market value")) && /¥1,900,000/.test(await money(card(/Gold Fund/), "Market value")));

  // ---- 6. edit
  await card(/eMAXIS/).getByRole("button", { name: "EDIT" }).click();
  check("Edit form is pre-filled with the saved values", (await page.getByLabel("Units held").inputValue()) === "1234567" && (await page.getByLabel("Prices are quoted").inputValue()) === "10000");
  await page.getByLabel("Units held").fill("2,000,000");
  await page.getByRole("button", { name: "SAVE CHANGES" }).click();
  // The form's live preview already shows the new value while typing, so wait for the DIALOG to close (save finished).
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10000 });
  await page.waitForFunction(() => document.body.innerText.includes("¥5,600,000"), null, { timeout: 10000 });
  check("Edit saved: 2,000,000 units x ¥28,000 / 10,000 = ¥5,600,000", /¥5,600,000/.test(await money(card(/eMAXIS/), "Market value")));

  // ---- 7. validation
  await page.getByRole("button", { name: "+ ADD HOLDING", exact: true }).click();
  await page.getByRole("button", { name: "ADD HOLDING", exact: true }).click();
  t = await text();
  check("Empty form is refused with field-level messages", /give the holding a name/.test(t) && /enter the number of units/.test(t) && /enter your average purchase price/.test(t));
  await page.getByLabel("Name").fill("Too big");
  await page.getByLabel("Units held").fill("99999999999999");
  await page.getByLabel("Average purchase price (¥)").fill("1");
  await page.getByRole("button", { name: "ADD HOLDING", exact: true }).click();
  await page.waitForTimeout(800);
  check("Server-side limits are enforced and the message is shown", /unreasonably large/.test(await text()));
  await page.getByRole("button", { name: "Close", exact: true }).click();

  // ---- 8. delete
  await card(/Gold Fund/).getByRole("button", { name: "DELETE" }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Gold Fund"), null, { timeout: 10000 });
  check("Delete (after confirmation) removes the holding and updates totals", (await page.getByRole("article").count()) === 2 && (await api("/api/holdings")).holdings.length === 2);

  // ---- 9. layout
  await page.screenshot({ path: OUT + "/portfolio-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("Phone width (390 px): no horizontal page overflow", overflow <= 1, `overflow ${overflow}px`);
  await page.screenshot({ path: OUT + "/portfolio-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1400, height: 1000 });

  // ---- 10. regression: the original terminal still works
  await page.getByRole("link", { name: "TERMINAL" }).click();
  await page.waitForURL(WEB + "/", { timeout: 15000 });
  await page.getByText("WATCHLIST", { exact: false }).first().waitFor({ timeout: 20000 });
  check("Original terminal still loads from the new nav link (widgets and search present)", /search symbol/.test(await text()));

  const unexpected = errors.filter((e) => !/status of 400/.test(e));
  check("No uncaught page errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | "));
  await browser.close();
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  fs.writeFileSync(OUT + "/investments-result.json", JSON.stringify(results));
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error("E2E crashed:", e); process.exit(2); });
