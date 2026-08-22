// Test scaffolding for this lane. It builds a runtime around the fake driver and a
// tool session with an origin policy, so a test states the page and the task origins and
// nothing else. Shipped code never imports it.

import type { PermissionRule } from "@mu/core";
import type { BrowserDriverFactory } from "../drivers/factory.ts";
import { createFakeBrowserDriver, type FakeBrowserDriver } from "../drivers/fake/driver.ts";
import type { FakeSite } from "../drivers/fake/site.ts";
import { taskAuthority } from "../policy/authority.ts";
import type { BrowserPolicyState } from "../policy/decide.ts";
import type { BrowserPermissionMode } from "../policy/modes.ts";
import { createOriginPolicy } from "../policy/origin.ts";
import { BrowserRuntime } from "../runtime/runtime.ts";
import { BrowserToolSession } from "./session.ts";

export interface HarnessOptions {
  site?: FakeSite | undefined;
  allowedOrigins?: readonly string[] | undefined;
  mode?: BrowserPermissionMode | undefined;
  rules?: readonly PermissionRule[] | undefined;
  allowInsecureDisclosure?: boolean | undefined;
}

export interface Harness {
  driver: FakeBrowserDriver;
  runtime: BrowserRuntime;
  session: BrowserToolSession;
  policy: BrowserPolicyState;
  signal: AbortSignal;
  shutdown: () => Promise<void>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const driver = createFakeBrowserDriver({
    ...(options.site === undefined ? {} : { site: options.site }),
  });
  const factory: BrowserDriverFactory = async () => ({
    driver,
    ownership: "attached",
    description: "a deterministic fake chrome",
    dispose: async () => {},
  });
  const runtime = new BrowserRuntime({
    factory,
    connection: "extension",
    browser: "chrome",
    dataRoot: "/tmp/mu-browser-tools-harness",
  });
  const policy: BrowserPolicyState = {
    origins: createOriginPolicy(
      {
        configuredOrigins: options.allowedOrigins ?? [],
        ...(options.allowInsecureDisclosure === undefined
          ? {}
          : { allowInsecureDisclosure: options.allowInsecureDisclosure }),
      },
      taskAuthority(),
    ),
    mode: options.mode ?? "confirm-submission",
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  };
  const session = new BrowserToolSession({ runtime, policy });
  return {
    driver,
    runtime,
    session,
    policy,
    signal: new AbortController().signal,
    shutdown: () => runtime.shutdown(),
  };
}

export function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
}
