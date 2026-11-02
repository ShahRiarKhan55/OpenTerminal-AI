const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

function nyWallClock(ms: number): [number, number, number, number, number] {
  const p: Record<string, number> = {};
  for (const part of nyParts.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return [p.year, p.month - 1, p.day, p.hour, p.minute];
}

/**
 * Convert a wall-clock time in America/New_York to epoch ms, DST-aware, without
 * a timezone library. Tries both possible UTC offsets and keeps the one whose
 * round-trip reproduces the input; returns null for non-existent local times
 * (spring-forward gap) or impossible dates (e.g. Feb 30).
 */
export function easternToEpochMs(y: number, m: number, d: number, hh: number, mm: number): number | null {
  const asUtc = Date.UTC(y, m, d, hh, mm);
  for (const offsetHours of [4, 5]) {
    const candidate = asUtc + offsetHours * 3_600_000;
    const [cy, cm, cd, ch, cmin] = nyWallClock(candidate);
    if (cy === y && cm === m && cd === d && ch === hh && cmin === mm) return candidate;
  }
  return null;
}

/**
 * Parse the timestamps Nasdaq's quote API returns, e.g.
 *   "Nov 2, 2026 8:32 AM ET"
 *   "Closed at Oct 30, 2026 4:00 PM ET"
 * Returns epoch SECONDS (the unit used by Quote.time), or null if the text
 * isn't a recognizable timestamp. Never guesses.
 */
export function parseNasdaqTimestamp(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = m[6].toUpperCase() === "PM";
  hour = (hour % 12) + (pm ? 12 : 0);
  const ms = easternToEpochMs(Number(m[3]), month, Number(m[2]), hour, minute);
  return ms === null ? null : Math.floor(ms / 1000);
}
