import { expect, test } from "vitest";
import type { MemoryType } from "../../src/core/types.js";
import { calendarDaysBetween, formatNow, formatWhen, nowHeader } from "../../src/retrieve/when.js";

const NOW = new Date("2026-09-04T11:32:00.000Z");
const TZ = "Europe/Athens";

function row(
  observed: string,
  opts: { valid_from?: string; supersedes?: boolean; type?: MemoryType; due?: string } = {},
) {
  return {
    attrs: opts.due ? { due: opts.due } : {},
    observed_at: new Date(observed),
    valid_from: opts.valid_from ? new Date(opts.valid_from) : null,
    supersedes_id: opts.supersedes ? "00000000-0000-0000-0000-000000000001" : null,
    type: opts.type ?? ("fact" as MemoryType),
  };
}

test("[NOW] shows the local clock, zone and weekday", () => {
  expect(formatNow(NOW, TZ)).toBe("2026-09-04 14:32 EEST (Fri)");
  expect(formatNow(NOW, "UTC")).toBe("2026-09-04 11:32 UTC (Fri)");
  expect(nowHeader(NOW, TZ)).toBe("[NOW] 2026-09-04 14:32 EEST (Fri)");
  // Midnight never prints as 24:00.
  expect(formatNow(new Date("2026-09-04T21:00:00.000Z"), TZ)).toBe("2026-09-05 00:00 EEST (Sat)");
});

test("age is compact and relative to now", () => {
  expect(formatWhen(row("2026-08-28T06:14:00Z"), NOW, TZ)).toBe("28 Aug, 7d ago");
  expect(formatWhen(row("2026-09-04T06:14:00Z"), NOW, TZ)).toBe("today 09:14");
  expect(formatWhen(row("2026-09-03T23:30:00Z"), NOW, TZ)).toBe("today 02:30");
  expect(formatWhen(row("2026-09-03T05:00:00Z"), NOW, TZ)).toBe("3 Sep, yesterday");
  expect(formatWhen(row("2026-01-01T00:00:00Z"), NOW, TZ)).toBe("1 Jan, 8mo ago");
  // 348 days is 11 calendar months and change, not "12mo".
  expect(formatWhen(row("2026-01-01T00:00:00Z"), new Date("2026-12-15T00:00:00Z"), "UTC")).toBe("1 Jan, 11mo ago");
  expect(formatWhen(row("2026-08-06T00:00:00Z"), NOW, TZ)).toBe("6 Aug, 29d ago");
  expect(formatWhen(row("2026-08-05T00:00:00Z"), NOW, TZ)).toBe("5 Aug, 1mo ago");
  expect(formatWhen(row("2024-03-01T00:00:00Z"), NOW, TZ)).toBe("1 Mar 2024, 2.5y ago");
  expect(formatWhen(row("2026-09-10T00:00:00Z"), NOW, TZ)).toBe("10 Sep, in 6d");
});

test("calendar days follow the zone, not UTC", () => {
  // 23:30Z on the 3rd is already the 4th in Athens.
  expect(calendarDaysBetween(new Date("2026-09-03T23:30:00Z"), NOW, TZ)).toBe(0);
  expect(calendarDaysBetween(new Date("2026-09-03T23:30:00Z"), NOW, "UTC")).toBe(1);
});

test("updated marks a row that supersedes another; happened/since expose valid_from", () => {
  expect(formatWhen(row("2026-08-28T06:14:00Z", { supersedes: true }), NOW, TZ)).toBe("updated 28 Aug, 7d ago");
  expect(formatWhen(row("2026-08-28T06:14:00Z", { valid_from: "2026-08-20T00:00:00Z", type: "event" }), NOW, TZ)).toBe(
    "happened 20 Aug; saved 28 Aug, 7d ago",
  );
  expect(formatWhen(row("2026-08-28T06:14:00Z", { valid_from: "2025-08-20T00:00:00Z" }), NOW, TZ)).toBe(
    "since 20 Aug 2025; saved 28 Aug, 7d ago",
  );
  // valid_from on the same day as the save adds nothing.
  expect(formatWhen(row("2026-08-28T06:14:00Z", { valid_from: "2026-08-28T20:00:00Z", type: "event" }), NOW, TZ)).toBe(
    "28 Aug, 7d ago",
  );
});

test("goals show their deadline against the clock", () => {
  expect(formatWhen(row("2026-08-28T06:14:00Z", { type: "goal", due: "2026-09-15" }), NOW, TZ)).toBe(
    "28 Aug, 7d ago; due 15 Sep, in 11d",
  );
  expect(formatWhen(row("2026-08-28T06:14:00Z", { type: "goal", due: "2026-09-04T20:00:00Z" }), NOW, TZ)).toBe(
    "28 Aug, 7d ago; due today",
  );
  expect(formatWhen(row("2026-08-28T06:14:00Z", { type: "goal", due: "2026-09-01" }), NOW, TZ)).toBe(
    "28 Aug, 7d ago; due 1 Sep, 3d ago",
  );
  // A due date on a non-goal, or an unparsable one, is ignored.
  expect(formatWhen(row("2026-08-28T06:14:00Z", { type: "fact", due: "2026-09-15" }), NOW, TZ)).toBe("28 Aug, 7d ago");
  expect(formatWhen(row("2026-08-28T06:14:00Z", { type: "goal", due: "soon" }), NOW, TZ)).toBe("28 Aug, 7d ago");
});
