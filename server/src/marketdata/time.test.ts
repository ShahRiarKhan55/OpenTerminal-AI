import { describe, expect, it } from "vitest";
import { easternToEpochMs, parseNasdaqTimestamp } from "./time.js";

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
