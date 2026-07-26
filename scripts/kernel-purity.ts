// Kernel-purity check: @mu/core and @mu/ai must contain no domain concepts.
// Scans source text for forbidden identifiers; fails CI on any hit.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KERNEL_DIRS = ["packages/ai/src", "packages/core/src"];

const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /\bcwd\b/i, label: "cwd" },
  { pattern: /process\.chdir/, label: "process.chdir" },
  { pattern: /\bgit\b/i, label: "git" },
  { pattern: /node:fs|from ["']fs["']/, label: "filesystem import" },
  { pattern: /\bworkspace\b/i, label: "workspace" },
  { pattern: /\bscreenshot\b/i, label: "screenshot" },
  { pattern: /\bAGENTS\.md\b/, label: "AGENTS.md" },
];

// Session storage in core is allowed to touch fs via an injected store only; the
// file-backed store lives outside the kernel. No exceptions list yet — add here
// with justification if one becomes necessary.

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

let failures = 0;
for (const dir of KERNEL_DIRS) {
  let files: string[];
  try {
    files = [...walk(dir)];
  } catch {
    continue;
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(line)) {
          console.error(`${file}:${i + 1} forbidden concept "${label}": ${line.trim()}`);
          failures++;
        }
      }
    });
  }
}

if (failures > 0) {
  console.error(`\nkernel purity check FAILED: ${failures} hit(s)`);
  process.exit(1);
}
console.log("kernel purity check passed");
