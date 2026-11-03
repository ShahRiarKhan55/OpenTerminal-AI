# Personal Investment Command Center (Phase 1)

A **MY PORTFOLIO** page (top-bar link, `/portfolio`) that tracks your own long-term holdings in JPY.
It is a **record-keeping and valuation tool only**: it never places orders, never connects to a broker, and needs no API keys or paid data.

## Add holdings manually

1. Start the app as usual (Windows PowerShell, no WSL needed): `npm install` once, then `npm run dev` (or your usual start command) and open `http://localhost:3000/portfolio`.
2. Click **+ ADD HOLDING**. Use a preset (オルカン, Gold Fund, Bitcoin) or fill in the form:
   - **Name**, **Type** (mutual fund, commodity fund, ETF, stock, crypto, other), optional **Symbol**, **Currency** (JPY).
   - **Units** (fractional allowed, e.g. `0.0123` BTC; full-width digits and commas such as `１,２３４` are accepted).
   - **Average purchase price**: what you paid per price unit (see below).
   - **Current price / NAV** and its **as-of date**.
3. Save. Edit or delete a holding from its card. To update a NAV, use the card's price-update action and enter the new value and date.

### NAV per 10,000 units (important for Japanese funds)
Japanese mutual funds quote the 基準価額 (NAV) **per 10,000 units**. Choose the **price unit** "per 10,000 units" for such funds, then
`value = units × NAV ÷ 10,000`. For stocks, ETFs and crypto use "per 1 unit".
Enter the NAV exactly as your broker / the fund's official page shows it. Yahoo Finance is **not** used for fund NAVs.

### Bitcoin
Bitcoin uses symbol `BTC-JPY` with a live quote when the existing provider answers with a matching symbol and currency.
If the provider fails, is stale, or returns something else, the card says so and falls back to your manual price (flagged).

## How numbers are computed
- Market value = units × price ÷ price unit. Cost = units × average price ÷ price unit. P/L = value − cost; P/L % = P/L ÷ cost.
- A holding with **no price** is excluded from value and P/L and the dashboard is marked **incomplete**. Prices are never silently treated as fresh:
  badges show LIVE / MANUAL / STALE / NO PRICE. Staleness limits: live quote 15 min, manual NAV 96 h, manual crypto 24 h.
- Totals are JPY only. The API accepts JPY holdings only in Phase 1; any non-JPY holding would be excluded unless an explicit, fresh, dated FX rate exists (hook for future USD/BTC support).

## Storage
Holdings live in the existing SQLite database (migration 5, table `holdings`), so they survive reloads/restarts and are included in the existing backup/restore. No brokerage credentials are stored.

## Limitations
- JPY only; no FX conversion yet. No transaction history/lots (one average price per holding), no dividends, taxes or fees.
- Fund NAVs are manual. Live BTC-JPY depends on the existing provider and may be unavailable (some networks/regions are blocked).
- Maximum 200 holdings. Data entry is trusted-user, single-owner; protected by the existing API key / CSRF / host checks.
