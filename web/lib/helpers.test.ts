import { describe, expect, it } from "vitest";
import { ago, etTime, money, pnlClass, signed } from "./engine";
import { normalizeMonitorSymbol, normalizeSymbol, symbolsParam } from "./symbol";

describe("normalizeMonitorSymbol (must mirror the server's symbol rules: US stocks/ETFs only)", () => {
  it.each(["AAPL", "aapl", " msft ", "BRK.B", "BF-B", "A", "SPY"])("accepts %j", (s) => {
    expect(normalizeMonitorSymbol(s)).toBe(s.trim().toUpperCase());
  });
  it.each(["", "^GSPC", "^VIX", "BTC-USD", "EURUSD=X", "GC=F", "0700.HK", "M&M.NS", "TOOLONGSYMBOL", "AA PL", "AAPL;DROP", "../x", "1ABC", "A,B"])(
    "rejects %j",
    (s) => {
      expect(normalizeMonitorSymbol(s)).toBeNull();
    }
  );
});

describe("normalizeSymbol (display symbols stay permissive)", () => {
  it("still accepts indexes, futures and FX for the quote/chart widgets", () => {
    for (const s of ["^GSPC", "GC=F", "EURUSD=X", "0700.HK"]) expect(normalizeSymbol(s)).toBe(s);
  });
  it("rejects separators that would corrupt a comma-separated query", () => {
    expect(normalizeSymbol("A,B")).toBeNull();
    expect(normalizeSymbol("..")).toBeNull();
  });
  it("symbolsParam keeps the comma literal and encodes the rest", () => {
    expect(symbolsParam(["^VIX", "BRK.B"])).toBe("%5EVIX,BRK.B");
  });
});

describe("engine formatting helpers", () => {
  it("money", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(-0.5)).toBe("-$0.50");
    expect(money(null)).toBe("—");
    expect(money(NaN)).toBe("—");
  });
  it("signed and pnlClass", () => {
    expect(signed(1.234)).toBe("+1.23");
    expect(signed(-1.234)).toBe("-1.23");
    expect(signed(0)).toBe("+0.00");
    expect(signed(undefined)).toBe("—");
    expect([pnlClass(5), pnlClass(-5), pnlClass(0), pnlClass(null)]).toEqual(["up", "down", "dim", "dim"]);
  });
  it("ago", () => {
    const now = 1_000_000_000_000;
    expect([ago(now - 5_000, now), ago(now - 125_000, now), ago(now - 7_300_000, now), ago(now - 200_000_000, now), ago(now + 5000, now)]).toEqual(["5s", "2m", "2h", "2d", "0s"]);
  });
  it("etTime renders New York wall-clock time across DST", () => {
    expect(etTime(Date.UTC(2026, 6, 15, 13, 30))).toBe("09:30"); // EDT
    expect(etTime(Date.UTC(2026, 10, 2, 14, 30))).toBe("09:30"); // EST
  });
});
