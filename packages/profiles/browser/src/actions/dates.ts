// A date the user asked for, at the precision they gave.
export interface DateTarget {
  year: number;
  month?: number;
  day?: number;
}

export const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function monthOf(word: string): number | undefined {
  const lower = word.toLowerCase().replace(/\.$/, "");
  const index = MONTHS.findIndex(
    (month) => month === lower || (lower.length >= 3 && month.startsWith(lower)),
  );
  return index === -1 ? undefined : index + 1;
}

const valid = (target: DateTarget): DateTarget | undefined =>
  target.year >= 1900 &&
  target.year <= 2200 &&
  (target.month === undefined || (target.month >= 1 && target.month <= 12)) &&
  (target.day === undefined || (target.day >= 1 && target.day <= 31))
    ? target
    : undefined;

// Common written forms; day/month orders that could be either are refused, not guessed.
export function parseDate(text: string): DateTarget | undefined {
  const value = text.trim().replace(/\s+/g, " ");
  let match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(value);
  if (match)
    return valid({
      year: Number(match[1]),
      month: Number(match[2]),
      ...(match[3] ? { day: Number(match[3]) } : {}),
    });
  match = /^(\d{4})$/.exec(value);
  if (match) return valid({ year: Number(match[1]) });
  match = /^(\d{1,2})[/.-](\d{4})$/.exec(value);
  if (match) return valid({ year: Number(match[2]), month: Number(match[1]) });
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (match) {
    const [a, b, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (a > 12) return valid({ year, month: b, day: a });
    if (b > 12) return valid({ year, month: a, day: b });
    return undefined;
  }
  match = /^([a-z]+\.?) (\d{4})$/i.exec(value);
  if (match) {
    const month = monthOf(match[1] as string);
    return month ? valid({ year: Number(match[2]), month }) : undefined;
  }
  match = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+\.?),? (\d{4})$/i.exec(value);
  if (match) {
    const month = monthOf(match[2] as string);
    return month ? valid({ year: Number(match[3]), month, day: Number(match[1]) }) : undefined;
  }
  match = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(value);
  if (match) {
    const month = monthOf(match[1] as string);
    return month ? valid({ year: Number(match[3]), month, day: Number(match[2]) }) : undefined;
  }
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

// The value a native <input type=date|month> takes, if the target is precise enough.
export function isoFor(type: string, target: DateTarget): string | undefined {
  if (type === "month" && target.month) return `${target.year}-${pad(target.month)}`;
  if (type === "date" && target.month && target.day)
    return `${target.year}-${pad(target.month)}-${pad(target.day)}`;
  return undefined;
}

function mentionsMonth(name: string, month: number): boolean {
  const full = MONTHS[month - 1] as string;
  return new RegExp(`\\b(${full}|${full.slice(0, 3)})\\b`, "i").test(name);
}

const UNAVAILABLE = /\b(not available|unavailable|disabled)\b/i;
const VERB = /^(choose|select|pick|go to)\s+/i;

// Whether a picker element's name is the target date. `shown` is text visible in the
// picker (a heading like "March 2026"), for grids whose cells are bare numbers.
export function namesDate(name: string, target: DateTarget, shown: string): boolean {
  const text = name.trim();
  if (!text || UNAVAILABLE.test(text)) return false;
  const bare = text.replace(VERB, "");
  const hasYear = new RegExp(`\\b${target.year}\\b`).test(text);
  const showsYear = new RegExp(`\\b${target.year}\\b`).test(shown);
  if (target.month === undefined) return bare === String(target.year);
  if (target.day === undefined) {
    if (!mentionsMonth(text, target.month)) return false;
    if (hasYear) return true;
    return !/\b\d{4}\b/.test(text) && showsYear && bare.split(/\s+/).length === 1;
  }
  const dayPattern = new RegExp(`\\b${target.day}(st|nd|rd|th)?\\b`, "i");
  if (mentionsMonth(text, target.month) && hasYear && dayPattern.test(text)) return true;
  return bare === String(target.day) && showsYear && mentionsMonth(shown, target.month);
}

// The period a picker currently shows, as year*12+month, from the years and months
// named in its visible elements; undefined when it cannot tell.
export function shownPeriod(names: string[]): number | undefined {
  const periods: number[] = [];
  for (const name of names) {
    const year = /\b(19|20|21)\d{2}\b/.exec(name)?.[0];
    if (!year) continue;
    const month = MONTHS.findIndex((candidate) =>
      mentionsMonth(name, MONTHS.indexOf(candidate) + 1),
    );
    periods.push(Number(year) * 12 + (month === -1 ? 0 : month));
  }
  if (periods.length === 0) return undefined;
  periods.sort((a, b) => a - b);
  return periods[Math.floor(periods.length / 2)];
}

export function periodOf(target: DateTarget): number {
  return target.year * 12 + (target.month ? target.month - 1 : 0);
}
