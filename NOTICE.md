# Notice and attribution

**OpenTerminal AI** is a personal project derived from, and distributed under the same MIT license as,
[OpenTerminal](https://github.com/ErTasselli/OpenTerminal) by Andrea Tasselli and contributors
("Copyright (c) 2026 OpenTerminal contributors", see [LICENSE](LICENSE)). The original terminal (the Next.js
dashboard, Express API, market-data providers and portfolio tracker) is their work; this repository adds the
monitoring worker, paper-trading engine, alerting, notification, AI-analysis, security-hardening and deployment layers.

**Day Trader Skill** ([Jakeschincariol/day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill), MIT,
Copyright (c) 2026 Jake Schincariol) was studied as a design reference for the opening-range breakout, risk-check,
position-sizing and entry/exit ideas. **No code or prompt text was copied from it**; the logic here is an independent
TypeScript implementation. Its order-execution workflow (which depends on an LLM following instructions) is intentionally
not used: this application cannot place real orders.

Market data comes from free public endpoints (Nasdaq, Yahoo Finance, Stooq, TradingView scanner, FRED, ECB, Forex Factory,
SEC EDGAR, FINRA, CoinGecko, Binance). They are not officially licensed feeds; respect each provider's terms. Prices are
delayed or indicative. This software is not financial advice.
