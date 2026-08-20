import { page } from "./html.ts";
import { SubmissionRecorder } from "./recorder.ts";
import type { FixtureContext, FixtureRuntimeOptions, RouteTable } from "./router.ts";
import { mergeRoutes } from "./router.ts";
import { adversarialRoutes } from "./routes/adversarial.ts";
import { applyRoutes } from "./routes/apply.ts";
import { dialogRoutes } from "./routes/dialogs.ts";
import { fieldRoutes } from "./routes/fields.ts";
import { flakyRoutes } from "./routes/flaky.ts";
import { frameRoutes } from "./routes/frames.ts";
import { outcomeRoutes } from "./routes/outcomes.ts";
import { spaPrefixRoutes, spaRoutes } from "./routes/spa.ts";
import { staleRoutes } from "./routes/stale.ts";
import { takeoverRoutes } from "./routes/takeover.ts";
import { uploadRoutes } from "./routes/uploads.ts";
import { SessionStore } from "./session.ts";
import type { FixtureOptions, FixtureOrigin, FixtureSecrets } from "./types.ts";

const LOOPBACK = "127.0.0.1";

const DEFAULT_OPTIONS: FixtureRuntimeOptions = {
  staleRerenderMs: 600,
  maxUploadBytes: 128 * 1024,
  acceptedUploadMimeTypes: ["application/pdf"],
};

const SECRETS: FixtureSecrets = {
  password: "fixture-password-not-a-real-secret",
  mfaCode: "424242",
  otpCode: "13579",
  captchaAnswer: "MU7F3K",
};

export type FixtureHandle = {
  /** Base URL of the primary loopback origin, e.g. `http://127.0.0.1:41235`. */
  url: string;
  origin: string;
  port: number;
  /** A second loopback origin on a different port; every route is served there too. */
  crossOrigin: FixtureOrigin;
  /** In-process evidence. Deliberately not reachable over HTTP. */
  recorder: SubmissionRecorder;
  /** Synthetic values that satisfy the takeover fixtures. No real credential exists. */
  secrets: FixtureSecrets;
  options: FixtureRuntimeOptions;
  stop(): Promise<void>;
};

function buildRoutes(): RouteTable {
  return mergeRoutes(
    applyRoutes,
    fieldRoutes,
    frameRoutes,
    spaRoutes,
    spaPrefixRoutes,
    dialogRoutes,
    uploadRoutes,
    flakyRoutes,
    staleRoutes,
    takeoverRoutes,
    adversarialRoutes,
    outcomeRoutes,
  );
}

function notFound(pathname: string): Response {
  return page({
    id: "not-found",
    title: "Not found",
    status: 404,
    body: `<p data-not-found="${pathname.replace(/[<>&"']/g, "")}">No fixture route matches this path.</p>
<p><a href="/">Fixture index</a></p>`,
  });
}

function requirePort(port: number | undefined): number {
  if (port === undefined) throw new Error("fixture server did not bind a TCP port");
  return port;
}

export async function startFixture(options: FixtureOptions = {}): Promise<FixtureHandle> {
  const runtimeOptions: FixtureRuntimeOptions = {
    staleRerenderMs: options.staleRerenderMs ?? DEFAULT_OPTIONS.staleRerenderMs,
    maxUploadBytes: options.maxUploadBytes ?? DEFAULT_OPTIONS.maxUploadBytes,
    acceptedUploadMimeTypes: options.acceptedUploadMimeTypes ?? [
      ...DEFAULT_OPTIONS.acceptedUploadMimeTypes,
    ],
  };
  const routes = buildRoutes();
  const recorder = new SubmissionRecorder();
  const sessions = new SessionStore();
  const counters = new Map<string, number>();
  const origins = { primary: "", secondary: "" };

  const listen = (role: "primary" | "secondary") =>
    Bun.serve({
      hostname: LOOPBACK,
      port: 0,
      // Uploads must be able to exceed the strict limit so rejection is testable.
      maxRequestBodySize: 8 * 1024 * 1024,
      idleTimeout: 30,
      async fetch(req) {
        const url = new URL(req.url);
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) return notFound(url.pathname);
        const ctx: FixtureContext = {
          req,
          url,
          role,
          origins,
          recorder,
          sessions,
          secrets: SECRETS,
          options: runtimeOptions,
          counters,
        };
        return await handler(ctx);
      },
    });

  const primary = listen("primary");
  const secondary = listen("secondary");
  const primaryPort = requirePort(primary.port);
  const secondaryPort = requirePort(secondary.port);
  origins.primary = `http://${LOOPBACK}:${primaryPort}`;
  origins.secondary = `http://${LOOPBACK}:${secondaryPort}`;

  return {
    url: origins.primary,
    origin: origins.primary,
    port: primaryPort,
    crossOrigin: {
      url: origins.secondary,
      origin: origins.secondary,
      port: secondaryPort,
    },
    recorder,
    secrets: SECRETS,
    options: runtimeOptions,
    async stop() {
      await Promise.all([primary.stop(true), secondary.stop(true)]);
      sessions.clear();
      counters.clear();
    },
  };
}
