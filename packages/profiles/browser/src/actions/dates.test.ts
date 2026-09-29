import { expect, test } from "bun:test";
import { namesDate, parseDate, periodOf, shownPeriod } from "./dates.ts";

test("dates parse from common written forms; day/month orders that could be either are refused", () => {
  expect(parseDate("2026-03-15")).toEqual({ year: 2026, month: 3, day: 15 });
  expect(parseDate("2026-03")).toEqual({ year: 2026, month: 3 });
  expect(parseDate("02/2026")).toEqual({ year: 2026, month: 2 });
  expect(parseDate("March 2026")).toEqual({ year: 2026, month: 3 });
  expect(parseDate("Sep 2025")).toEqual({ year: 2025, month: 9 });
  expect(parseDate("15 March 2026")).toEqual({ year: 2026, month: 3, day: 15 });
  expect(parseDate("March 15th, 2026")).toEqual({ year: 2026, month: 3, day: 15 });
  expect(parseDate("25/12/2026")).toEqual({ year: 2026, month: 12, day: 25 });
  expect(parseDate("12/25/2026")).toEqual({ year: 2026, month: 12, day: 25 });
  expect(parseDate("2022")).toEqual({ year: 2022 });
  expect(parseDate("03/04/2026")).toBeUndefined();
  expect(parseDate("Ada Lovelace")).toBeUndefined();
  expect(parseDate("2026-13")).toBeUndefined();
});

test("picker elements are matched by what they name, never unavailable ones", () => {
  const month = { year: 2026, month: 2 };
  expect(namesDate("Choose February 2026", month, "")).toBe(true);
  expect(namesDate("Not available February 2026", month, "")).toBe(false);
  expect(namesDate("Choose February 2025", month, "")).toBe(false);
  expect(namesDate("Feb", month, "2026")).toBe(true);
  expect(namesDate("2022", { year: 2022 }, "")).toBe(true);
  expect(namesDate("2022 - 2033", { year: 2022 }, "")).toBe(false);
  const day = { year: 2026, month: 3, day: 15 };
  expect(namesDate("Choose Sunday, March 15th, 2026", day, "")).toBe(true);
  expect(namesDate("15", day, "‹ | March 2026 | ›")).toBe(true);
  expect(namesDate("15", day, "April 2026")).toBe(false);
  expect(
    shownPeriod(["Choose January 2026", "Choose May 2026", "Not available December 2026"]),
  ).toBe(periodOf({ year: 2026, month: 5 }));
});
