import type { Memory } from "../core/types.js";

/**
 * Time, as the consuming agent should see it: the clock of the machine that
 * serves memory, and each memory's age relative to that clock.
 *
 * Domain code never reads the wall clock; `now` comes in as a parameter. The
 * time zone is the only environment fact read here, and callers can pin it.
 */

export type WhenRow = Pick<Memory, "observed_at" | "valid_from" | "supersedes_id" | "type" | "attrs">;

const DAY_MS = 86_400_000;

/** The time zone of the machine morfeu runs on. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** `2026-09-04 14:32 EEST (Fri)` in the given zone. */
export function formatNow(now: Date, timeZone: string): string {
  const p = parts(now, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute} ${zoneAbbrev(now, timeZone)} (${p.weekday})`;
}

/** The line every context starts with. */
export function nowHeader(now: Date, timeZone: string): string {
  return `[NOW] ${formatNow(now, timeZone)}`;
}

/**
 * Compact age for one memory line, e.g.
 *   `28 Aug, 7d ago`
 *   `today 09:14`
 *   `updated 28 Aug, 7d ago`                (this row supersedes an older one)
 *   `happened 20 Aug; saved 28 Aug, 7d ago` (an event dated before it was saved)
 *   `since 20 Aug; saved 28 Aug, 7d ago`    (any other type with an earlier valid_from)
 *   `28 Aug, 7d ago; due 15 Sep, in 11d`    (goal with attrs.due)
 */
export function formatWhen(memory: WhenRow, now: Date, timeZone: string): string {
  const saved = dayLabel(memory.observed_at, now, timeZone);
  const savedPart = memory.supersedes_id ? `updated ${saved}` : saved;
  const from = memory.valid_from;
  const base =
    from && dayKey(from, timeZone) !== dayKey(memory.observed_at, timeZone)
      ? `${memory.type === "event" ? "happened" : "since"} ${calendarDay(from, now, timeZone)}; saved ${savedPart}`
      : savedPart;
  const due = memory.type === "goal" ? dueDate(memory.attrs) : null;
  return due ? `${base}; due ${dueLabel(due, now, timeZone)}` : base;
}

// Goals keep their deadline in attrs.due; valid_until would hide them from search.
function dueDate(attrs: Record<string, unknown>): Date | null {
  const raw = attrs.due;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** `15 Sep, in 11d`, `today`, or `1 Sep, 3d ago` once it has passed. */
function dueLabel(due: Date, now: Date, timeZone: string): string {
  const days = calendarDaysBetween(due, now, timeZone);
  if (days === 0) return "today";
  return `${calendarDay(due, now, timeZone)}, ${relative(due, now, timeZone, days)}`;
}

/** `28 Aug, 7d ago`, or `today 09:14` when it is the same calendar day. */
function dayLabel(at: Date, now: Date, timeZone: string): string {
  const days = calendarDaysBetween(at, now, timeZone);
  if (days === 0) return `today ${clock(at, timeZone)}`;
  return `${calendarDay(at, now, timeZone)}, ${relative(at, now, timeZone, days)}`;
}

/** `28 Aug`, with the year appended when it differs from now's year. */
function calendarDay(at: Date, now: Date, timeZone: string): string {
  const p = parts(at, timeZone, { day: "numeric", month: "short", year: "numeric" });
  const nowYear = parts(now, timeZone, { year: "numeric" }).year;
  return p.year === nowYear ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

function relative(at: Date, now: Date, timeZone: string, days: number): string {
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  if (days < 0) return `in ${span(now, at, timeZone, -days)}`;
  return `${span(at, now, timeZone, days)} ago`;
}

// Under a month in days, under a year in whole calendar months, then years to one decimal.
function span(from: Date, to: Date, timeZone: string, days: number): string {
  if (days < 30) return `${days}d`;
  const months = Math.max(1, calendarMonthsBetween(from, to, timeZone));
  if (months < 12) return `${months}mo`;
  const years = days / 365.25;
  return years < 10 ? `${Number(years.toFixed(1))}y` : `${Math.round(years)}y`;
}

function calendarMonthsBetween(from: Date, to: Date, timeZone: string): number {
  const a = parts(from, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  const b = parts(to, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  const months = (Number(b.year) - Number(a.year)) * 12 + (Number(b.month) - Number(a.month));
  return Number(b.day) < Number(a.day) ? months - 1 : months;
}

function clock(at: Date, timeZone: string): string {
  const p = parts(at, timeZone, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

/** Whole calendar days from `at` to `now` in the zone; negative when `at` is in the future. */
export function calendarDaysBetween(at: Date, now: Date, timeZone: string): number {
  return Math.round((dayStartUtc(now, timeZone) - dayStartUtc(at, timeZone)) / DAY_MS);
}

function dayKey(at: Date, timeZone: string): string {
  const p = parts(at, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

// The calendar date in the zone, re-read as a UTC midnight, so two dates
// subtract to whole days regardless of DST shifts inside the zone.
function dayStartUtc(at: Date, timeZone: string): number {
  const p = parts(at, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
}

// en-GB names zones (EEST, BST, CET); en-US falls back to GMT+3 for most of them.
function zoneAbbrev(at: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

function parts(at: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone, ...options }).formatToParts(at)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}
