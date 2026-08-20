import type { SubmissionRecorder } from "./recorder.ts";
import type { SessionStore } from "./session.ts";
import type { FixtureSecrets } from "./types.ts";

export type FixtureRuntimeOptions = {
  staleRerenderMs: number;
  maxUploadBytes: number;
  acceptedUploadMimeTypes: string[];
};

export type FixtureContext = {
  req: Request;
  url: URL;
  /** Which of the two loopback origins served this request. */
  role: "primary" | "secondary";
  origins: { primary: string; secondary: string };
  recorder: SubmissionRecorder;
  sessions: SessionStore;
  secrets: FixtureSecrets;
  options: FixtureRuntimeOptions;
  /** Per-instance counters so concurrent fixtures never share transient-failure state. */
  counters: Map<string, number>;
};

export type RouteHandler = (ctx: FixtureContext) => Response | Promise<Response>;

/** Keys are `METHOD /path`. */
export type RouteTable = Record<string, RouteHandler>;

export type PrefixRoute = {
  method: string;
  prefix: string;
  handler: RouteHandler;
};

export function mergeRoutes(...tables: RouteTable[]): RouteTable {
  const merged: RouteTable = {};
  for (const table of tables) {
    for (const [key, handler] of Object.entries(table)) {
      if (key in merged) throw new Error(`duplicate fixture route: ${key}`);
      merged[key] = handler;
    }
  }
  return merged;
}
