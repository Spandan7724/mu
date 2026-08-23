// `mu-browser doctor`. Read-only environment checks, no network, no browser
// launched, nothing downloaded (PACKAGING §Installation Experience).
import { stat } from "node:fs/promises";
import {
  BROWSER_EXECUTABLE_ENV,
  discoverBrowserExecutable,
  extensionTopology,
  isSnapConfined,
  PINNED_SIDECAR_VERSION,
  persistentTopology,
  resolveSidecar,
  SIDECAR_CLI_ENV,
  SNAP_DOWNLOAD_WARNING,
} from "@mu/profile-browser/drivers";
import { browserDataLayout } from "@mu/profile-browser/profile";
import { BROWSER_COMMAND } from "./product.ts";

export interface DoctorIo {
  stdout: (chunk: string) => void;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function browserDoctorChecks(home?: string): Promise<DoctorCheck[]> {
  const layout = browserDataLayout(home);
  const checks: DoctorCheck[] = [];
  for (const [name, path] of Object.entries(layout)) {
    if (name === "config") continue;
    const found = await stat(path).then(
      (entry) => (entry.isDirectory() ? "present" : "not a directory"),
      () => "will be created on first run",
    );
    checks.push({
      name: `data ${name}`,
      ok: found !== "not a directory",
      detail: `${path} (${found})`,
    });
  }
  checks.push({
    name: "deterministic fake browser",
    ok: true,
    detail: `available — ${BROWSER_COMMAND} --fake-browser`,
  });
  // Read-only: resolving a path and reading env vars. Nothing is spawned here.
  let runtime: string | undefined;
  try {
    const resolution = resolveSidecar({ resolveFrom: [import.meta.url] });
    runtime = resolution.runtime;
    checks.push({
      name: "Playwright MCP sidecar",
      ok: true,
      detail: `${resolution.cli} (expects ${PINNED_SIDECAR_VERSION}), run by ${resolution.runtime}`,
    });
  } catch (error) {
    checks.push({
      name: "Playwright MCP sidecar",
      ok: false,
      detail: `${error instanceof Error ? error.message : String(error)} (set ${SIDECAR_CLI_ENV} to override)`,
    });
  }

  const topology = extensionTopology(runtime === undefined ? {} : { runtime });
  checks.push({
    name: "existing-browser bridge",
    ok: topology.supported,
    detail: topology.supported
      ? "the sidecar can reach the browser from here; the browser will ask you to approve the connection"
      : (topology.reason ?? "unsupported topology"),
  });

  // A stable check name whatever is installed, so a report reads the same everywhere.
  const found = ["chrome", "edge", "chromium"].reduce<
    { ok: true; detail: string } | { ok: false; detail: string }
  >(
    (best, browser) => {
      if (best.ok) return best;
      try {
        const executablePath = discoverBrowserExecutable(browser);
        const verdict = persistentTopology({ executablePath });
        // Already actionable on its own; appending the override hint would be wrong,
        // because pointing the variable somewhere else is not what fixes it.
        if (!verdict.supported) return { ok: false, detail: verdict.reason ?? "unsupported" };
        const confined = isSnapConfined(executablePath) ? ` — ${SNAP_DOWNLOAD_WARNING}` : "";
        return { ok: true, detail: `${browser} at ${executablePath}${confined}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: `${message} (set ${BROWSER_EXECUTABLE_ENV} to override)` };
      }
    },
    { ok: false, detail: "no chrome-family browser was looked for" },
  );
  checks.push({
    name: "Mu-owned browser",
    ok: found.ok,
    detail: found.detail,
  });
  return checks;
}

export async function runBrowserDoctor(io: DoctorIo, home?: string): Promise<number> {
  const checks = await browserDoctorChecks(home);
  io.stdout(`${BROWSER_COMMAND} doctor\n\n`);
  for (const check of checks) {
    io.stdout(`  ${check.ok ? "ok  " : "note"}  ${check.name}: ${check.detail}\n`);
  }
  io.stdout("\nNo network was used and no browser was launched.\n");
  // Unavailable connection modes are reported, not treated as a broken install.
  return 0;
}
