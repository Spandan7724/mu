// Replays settle rules over a recorded ActionLog. Mirrors src/page/settle.ts and
// src/page/network.ts; the report checks the current rule against real settle times.
import type { ActionLog, ProbeRequest } from "./run.ts";

type Mode = "in-page" | "typing" | "navigation";
interface Profile {
  graceMs: number;
  domQuietMs: number;
  networkQuietMs: number;
  capMs: number;
}
const PROFILES: Record<Mode, Profile> = {
  "in-page": { graceMs: 100, domQuietMs: 150, networkQuietMs: 150, capMs: 2_500 },
  typing: { graceMs: 350, domQuietMs: 250, networkQuietMs: 150, capMs: 2_500 },
  navigation: { graceMs: 100, domQuietMs: 200, networkQuietMs: 300, capMs: 10_000 },
};
const LONG_POLL_MS = 1_500;
const WRITE_CAP_MS = 15_000;
const IGNORED = new Set([
  "WebSocket",
  "EventSource",
  "Media",
  "Ping",
  "Prefetch",
  "CSPViolationReport",
]);
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface Context {
  watchedFrom: number;
  actionEnd: number;
  // When the new document committed and loaded, if the action navigated.
  commitAt: number | undefined;
  loadedAt?: number | undefined;
  // Registrable domain of the page the action ends on.
  site?: string | undefined;
}

// eTLD+1, approximately: enough for telling a site's own requests from third parties.
export function siteOf(host: string): string {
  const labels = host.split(":")[0]?.split(".") ?? [];
  const second = labels.at(-2) ?? "";
  const keep =
    /^(co|com|org|net|gov|ac|edu)$/.test(second) && (labels.at(-1)?.length ?? 0) === 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export interface Rule {
  name: string;
  description: string;
  // Whether a request holds network quiet.
  counts: (request: ProbeRequest, ctx: Context) => boolean;
  // Whether an unfinished write is work the action started (extends the cap, blocks quiet).
  isActionWrite: (request: ProbeRequest, ctx: Context) => boolean;
  // Keep waiting while the page shows a busy indicator.
  busyGuard?: boolean;
  // DOM-quiet cap once a navigation's document has loaded.
  navDomCapMs?: number;
  // Also return once the viewport snapshot has not changed for this long (no busy
  // indicator, no action write in flight), however busy the network is.
  stableMs?: number;
  // The stability exit also waits for scripts the page is still downloading.
  stableWaitsForScripts?: boolean;
  // Requests that stay pending past the long-poll age.
  noLongPoll?: (request: ProbeRequest, ctx: Context) => boolean;
}

const tracked = (request: ProbeRequest) => !IGNORED.has(request.type) && request.url !== "data:";

export const CURRENT: Rule = {
  name: "current",
  description: "settle.ts today",
  counts: tracked,
  isActionWrite: (request, ctx) =>
    tracked(request) && !READS.has(request.method) && request.start >= ctx.watchedFrom,
};

// Types whose response can change the text the model reads.
const CONTENT_TYPES = new Set(["Document", "Script", "Stylesheet", "XHR", "Fetch"]);

export const actionWrites =
  (windowMs: number): Rule["isActionWrite"] =>
  (request, ctx) =>
    CURRENT.isActionWrite(request, ctx) &&
    (ctx.commitAt !== undefined
      ? request.start <= ctx.commitAt
      : request.start <= ctx.actionEnd + windowMs);

// A data request the action started (≤1 s after it, or ≤1 s after a navigation's
// DOMContentLoaded) is the action's own work, not a long-poll, however long it takes.
const fromAction = (request: ProbeRequest, ctx: Context) =>
  CONTENT_TYPES.has(request.type) &&
  request.start >= ctx.watchedFrom &&
  request.start <= (ctx.loadedAt ?? ctx.actionEnd) + 1_000;

const content = (request: ProbeRequest) => tracked(request) && CONTENT_TYPES.has(request.type);

export const RULES: Rule[] = [
  CURRENT,
  {
    name: "A",
    description:
      "writes count only when the action started them (before commit / ≤1 s after the action)",
    counts: tracked,
    isActionWrite: actionWrites(1_000),
  },
  ...[2_000, 3_000].flatMap((stableMs): Rule[] => [
    {
      name: `A+O${stableMs}`,
      description: `A, and return once the viewport snapshot has been unchanged for ${stableMs} ms`,
      counts: tracked,
      isActionWrite: actionWrites(1_000),
      busyGuard: true,
      stableMs,
    },
    {
      name: `A+O${stableMs}s`,
      description: `A+O${stableMs}, but not while a script is still downloading`,
      counts: tracked,
      isActionWrite: actionWrites(1_000),
      busyGuard: true,
      stableMs,
      stableWaitsForScripts: true,
    },
  ]),
  {
    name: "A+T",
    description: "A, and only document/script/stylesheet/XHR/fetch requests hold network quiet",
    counts: content,
    isActionWrite: actionWrites(1_000),
  },
  {
    name: "A+T+B",
    description: "A+T, and a visible busy indicator keeps it waiting",
    counts: content,
    isActionWrite: actionWrites(1_000),
    busyGuard: true,
  },
  {
    name: "A+T+B+L",
    description: "A+T+B, and data requests the action started are never long-polls",
    counts: content,
    isActionWrite: actionWrites(1_000),
    busyGuard: true,
    noLongPoll: fromAction,
  },
  {
    name: "A+T+B+L+D",
    description: "A+T+B+L, and DOM churn after a load stops counting after 3 s",
    counts: content,
    isActionWrite: actionWrites(1_000),
    busyGuard: true,
    noLongPoll: fromAction,
    navDomCapMs: 3_000,
  },
];

export interface Simulated {
  at: number;
  reason: string;
}

const TICK = 5;
const normLine = (line: string) => line.replace(/\d+/g, "#").trim();

export function simulate(log: ActionLog, rule: Rule): Simulated | undefined {
  const trace = log.traces.at(-1);
  if (!trace) return undefined;
  const { watchedFrom, actionEnd } = trace;
  const mode = trace.mode as Mode;
  const events = log.page.filter((event) => event.t >= watchedFrom);
  const navigationAt =
    mode === "navigation"
      ? actionEnd
      : events.find(
          (event) =>
            (event.kind.startsWith("startedNavigating:") &&
              !/sameDocument|historySameDocument/.test(event.kind)) ||
            event.kind === "navigated",
        )?.t;
  const navigated = events.filter((event) => event.kind === "navigated");
  const sameDocumentAt = events.find((event) => event.kind === "sameDocument")?.t;
  const commitAt = navigated[0]?.t;
  const pageHost =
    /\[page\] url: \w+:\/\/([^/\s]+)/.exec(log.observation ?? "")?.[1] ??
    log.requests
      .find((request) => request.type === "Document" && request.start >= watchedFrom)
      ?.url.split("/")[0];
  const ctx: Context = {
    watchedFrom,
    actionEnd,
    commitAt,
    site: pageHost ? siteOf(pageHost) : undefined,
  };
  const requests = log.requests;
  const mutations = log.mutations.filter((t) => t >= watchedFrom).sort((a, b) => a - b);
  const samples = log.samples.filter((sample) => !sample.error);

  // DOM quiet started at `start`: resolves at quiet ms after the last mutation, or at cap.
  const domQuietAt = (start: number, quiet: number, cap: number) => {
    let due = start + quiet;
    for (const t of mutations) {
      if (t < start) continue;
      if (t >= due) break;
      due = t + quiet;
    }
    return Math.min(due, start + cap);
  };

  let profile = PROFILES[mode];
  let phase: "in-page" | "navigation" = "in-page";
  let phaseStart = actionEnd;
  let domDone: number | undefined = domQuietAt(actionEnd, profile.domQuietMs, profile.capMs);
  let navigationDomStarted = false;
  let writeSeen = false;
  let writesAt = Number.NEGATIVE_INFINITY;
  let writesBefore = 0;
  for (let now = actionEnd; ; now += TICK) {
    if (phase === "in-page" && navigationAt !== undefined && now >= navigationAt) {
      phase = "navigation";
      profile = PROFILES.navigation;
      phaseStart = now;
      domDone = undefined;
    }
    const inflight = requests.filter(
      (request) => request.start <= now && (request.end === undefined || request.end > now),
    );
    const writes = inflight.filter((request) => rule.isActionWrite(request, ctx)).length;
    if (writes > 0) writeSeen = true;
    if (writes > 0) writesAt = now;
    if (writesBefore > 0 && writes === 0 && phase === "in-page" && navigationAt === undefined)
      domDone = domQuietAt(now, profile.domQuietMs, WRITE_CAP_MS);
    writesBefore = writes;
    const capMs = writeSeen ? Math.max(profile.capMs, WRITE_CAP_MS) : profile.capMs;
    if (now - actionEnd >= capMs) {
      return {
        at: now,
        reason:
          writes > 0
            ? "cap: action write in flight"
            : phase === "navigation"
              ? "cap: navigation"
              : "cap: in-page",
      };
    }
    if (phase === "navigation") {
      const loader = navigated.filter((event) => event.t <= now).at(-1)?.loaderId;
      if (!loader && sameDocumentAt !== undefined && now >= sameDocumentAt)
        return { at: now, reason: "same-document" };
      const loadedAt = loader
        ? events.find((event) => event.kind === "DOMContentLoaded" && event.loaderId === loader)?.t
        : undefined;
      if (loadedAt === undefined || now < loadedAt) continue;
      ctx.loadedAt = loadedAt;
      if (!navigationDomStarted) {
        navigationDomStarted = true;
        domDone = domQuietAt(now, profile.domQuietMs, rule.navDomCapMs ?? profile.capMs);
      }
    }
    const scriptsLoading =
      rule.stableWaitsForScripts === true &&
      inflight.some((request) => request.type === "Script" && request.start >= watchedFrom);
    if (rule.stableMs !== undefined && writes === 0 && !scriptsLoading) {
      const from = Math.max(phase === "navigation" ? (ctx.loadedAt ?? now) : actionEnd, writesAt);
      const seen = samples.filter((sample) => sample.t >= from && sample.tEnd <= now);
      const last = seen.at(-1);
      if (last?.lines && last.lines.length > 2 && !last.busy && now - last.tEnd < 50) {
        const key = (lines: string[] | undefined) => (lines ?? []).map(normLine).join("\n");
        const latest = key(last.lines);
        let first = last;
        for (let i = seen.length - 2; i >= 0 && key(seen[i]?.lines) === latest; i--)
          first = seen[i] ?? first;
        if (last.tEnd - first.t >= rule.stableMs) return { at: now, reason: "viewport stable" };
      }
    }
    if (domDone === undefined || now < domDone) continue;
    const counted = requests.filter((request) => rule.counts(request, ctx));
    const pending = counted.filter(
      (request) =>
        request.start <= now &&
        (request.end === undefined || request.end > now) &&
        (now - request.start < LONG_POLL_MS || rule.noLongPoll?.(request, ctx) === true),
    ).length;
    let lastActivity = 0;
    for (const request of counted) {
      if (request.start <= now) lastActivity = Math.max(lastActivity, request.start);
      if (request.end !== undefined && request.end <= now)
        lastActivity = Math.max(lastActivity, request.end);
    }
    const networkIdleAt = Math.max(lastActivity, phaseStart) + profile.networkQuietMs;
    if (pending > 0 || writes > 0 || now < networkIdleAt || now < actionEnd + profile.graceMs)
      continue;
    if (rule.busyGuard) {
      const seen = samples.filter((sample) => sample.tEnd <= now).at(-1);
      if (seen?.busy) continue;
    }
    return { at: now, reason: phase === "navigation" ? "loaded and quiet" : "settled" };
  }
}
