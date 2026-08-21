// `mu-browser doctor`. Read-only environment checks, no network, no browser
// launched, nothing downloaded (PACKAGING §Installation Experience).
import { stat } from "node:fs/promises";
import { browserDataLayout } from "@mu/profile-browser/profile";
import { UNAVAILABLE_EXTENSION, UNAVAILABLE_PERSISTENT } from "./drivers.ts";
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
  checks.push({ name: "existing-browser bridge", ok: false, detail: UNAVAILABLE_EXTENSION });
  checks.push({ name: "Mu-owned browser", ok: false, detail: UNAVAILABLE_PERSISTENT });
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
