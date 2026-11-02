import { describe, expect, it } from "vitest";
import { easternToEpochMs, etClock, etDayBounds, parseHm, parseNasdaqTimestamp } from "./time.js";

const sec = (y: number, m: number, d: number, h: number, mi: number) => Date.UTC(y, m - 1, d, h, mi) / 1000;

describe("parseNasdaqTimestamp", () => {
  it("parses a standard-time (EST) timestamp, the real API format", () => {
    // DST ended Nov 1 2026, so Nov 2 is UTC-5.
    expect(parseNasdaqTimestamp("Nov 2, 2026 8:32 AM ET")).toBe(sec(2026, 11, 2, 13, 32));
  });

  it("parses a daylight-time (EDT) timestamp with the 'Closed at' prefix", () => {
    expect(parseNasdaqTimestamp("Closed at Oct 30, 2026 4:00 PM ET")).toBe(sec(2026, 10, 30, 20, 0));
  });

  it("handles summer open", () => {
    expect(parseNasdaqTimestamp("Jul 15, 2026 9:30 AM ET")).toBe(sec(2026, 7, 15, 13, 30));
  });

  it("handles 12 AM and 12 PM correctly", () => {
    expect(parseNasdaqTimestamp("Jul 15, 2026 12:00 AM ET")).toBe(sec(2026, 7, 15, 4, 0));
    expect(parseNasdaqTimestamp("Jul 15, 2026 12:00 PM ET")).toBe(sec(2026, 7, 15, 16, 0));
  });

  it("rejects a local time that does not exist (spring-forward gap)", () => {
    expect(parseNasdaqTimestamp("Mar 8, 2026 2:30 AM ET")).toBeNull();
    expect(parseNasdaqTimestamp("Mar 8, 2026 3:00 AM ET")).toBe(sec(2026, 3, 8, 7, 0));
  });

  it("resolves the ambiguous fall-back hour deterministically (earlier instant)", () => {
    expect(parseNasdaqTimestamp("Nov 1, 2026 1:30 AM ET")).toBe(sec(2026, 11, 1, 5, 30));
  });

  it.each([
    "N/A",
    "",
    "DATA AS OF Nov 2, 2026",
    "Foo 2, 2026 8:32 AM ET",
    "Feb 30, 2026 8:32 AM ET",
    "Nov 2, 2026 13:32 PM ET",
    "Nov 2, 2026 8:75 AM ET",
  ])("returns null instead of guessing for %j", (text) => {
    expect(parseNasdaqTimestamp(text)).toBeNull();
  });

  it("returns null for non-strings", () => {
    expect(parseNasdaqTimestamp(null)).toBeNull();
    expect(parseNasdaqTimestamp(undefined)).toBeNull();
    expect(parseNasdaqTimestamp(12345)).toBeNull();
  });
});

describe("easternToEpochMs", () => {
  it("rejects impossible dates", () => {
    expect(easternToEpochMs(2026, 1, 30, 10, 0)).toBeNull();
  });
});


describe("etClock (exchange wall-clock, DST-aware)", () => {
  it("reads New York local date, minutes and weekday across the year", () => {
    expect(etClock(Date.UTC(2026, 6, 15, 13, 30))).toMatchObject({ dateKey: "2026-07-15", minutes: 9 * 60 + 30, weekday: 3, isWeekday: true }); // EDT
    expect(etClock(Date.UTC(2026, 10, 2, 14, 30))).toMatchObject({ dateKey: "2026-11-02", minutes: 9 * 60 + 30, weekday: 1, isWeekday: true }); // EST
  });
  it("uses the NEW YORK date, not the UTC date (a late-evening ET time is already tomorrow in UTC)", () => {
    expect(etClock(Date.UTC(2026, 6, 16, 3, 30))).toMatchObject({ dateKey: "2026-07-15", minutes: 23 * 60 + 30 });
  });
  it("knows weekends", () => {
    expect(etClock(Date.UTC(2026, 6, 18, 16, 0)).isWeekday).toBe(false); // Saturday
    expect(etClock(Date.UTC(2026, 6, 19, 16, 0)).isWeekday).toBe(false); // Sunday
  });
  it("handles midnight as minute 0, not 1440", () => {
    expect(etClock(Date.UTC(2026, 6, 15, 4, 0))).toMatchObject({ dateKey: "2026-07-15", minutes: 0 });
  });
  it("is correct on the days the clocks change", () => {
    // 2026-03-08 spring forward: 07:00Z is 03:00 EDT (02:00 EST never existed)
    expect(etClock(Date.UTC(2026, 2, 8, 7, 0))).toMatchObject({ dateKey: "2026-03-08", minutes: 3 * 60 });
    expect(etClock(Date.UTC(2026, 2, 8, 6, 59))).toMatchObject({ minutes: 1 * 60 + 59 });
    // 2026-11-01 fall back: 06:00Z is 01:00 EST, 05:30Z is 01:30 EDT
    expect(etClock(Date.UTC(2026, 10, 1, 6, 0))).toMatchObject({ dateKey: "2026-11-01", minutes: 60 });
    expect(etClock(Date.UTC(2026, 10, 1, 5, 30))).toMatchObject({ minutes: 60 + 30 });
  });
});

describe("etDayBounds", () => {
  it("is 24h on a normal day, 23h when clocks spring forward, 25h when they fall back", () => {
    const len = (k: string) => { const b = etDayBounds(k)!; return (b.endMs - b.startMs) / 3_600_000; };
    expect(len("2026-07-15")).toBe(24);
    expect(len("2026-03-08")).toBe(23);
    expect(len("2026-11-01")).toBe(25);
  });
  it("starts at ET midnight and consecutive days tile with no gap or overlap", () => {
    const a = etDayBounds("2026-07-15")!;
    expect(etClock(a.startMs)).toMatchObject({ dateKey: "2026-07-15", minutes: 0 });
    expect(etClock(a.endMs - 1).dateKey).toBe("2026-07-15");
    expect(etDayBounds("2026-07-16")!.startMs).toBe(a.endMs);
  });
  it("rejects malformed keys", () => {
    for (const k of ["", "2026-7-1", "tomorrow", "2026-13-40x"]) expect(etDayBounds(k)).toBeNull();
  });
});

describe("parseHm", () => {
  it("parses valid HH:MM and rejects the rest", () => {
    expect(parseHm("09:45")).toBe(585);
    expect(parseHm("00:00")).toBe(0);
    expect(parseHm("23:59")).toBe(1439);
    for (const bad of ["9:45", "24:00", "12:60", "12:5", "", "ab:cd", "12:30:00", " 12:30"]) expect(parseHm(bad)).toBeNull();
  });
});
