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

const etDateParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

export type EtClock = {
  /** Exchange-local calendar date, YYYY-MM-DD. */
  dateKey: string;
  /** Minutes since local midnight, 0..1439. */
  minutes: number;
  /** 0 = Sunday .. 6 = Saturday. */
  weekday: number;
  isWeekday: boolean;
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock view of an instant in America/New_York (DST-aware). */
export function etClock(ms: number): EtClock {
  const p: Record<string, string> = {};
  for (const part of etDateParts.formatToParts(new Date(ms))) p[part.type] = part.value;
  const weekday = WEEKDAYS[p.weekday] ?? 0;
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday,
    isWeekday: weekday >= 1 && weekday <= 5,
  };
}

/** "HH:MM" -> minutes since midnight; null when malformed. */
export function parseHm(hm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** [start, end) epoch-ms bounds of an ET calendar day (23/25h on DST changes). */
export function etDayBounds(dateKey: string): { startMs: number; endMs: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const next = new Date(Date.UTC(y, mo, d + 1));
  const start = easternToEpochMs(y, mo, d, 0, 0);
  const end = easternToEpochMs(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), 0, 0);
  return start === null || end === null ? null : { startMs: start, endMs: end };
}
