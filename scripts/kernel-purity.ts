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

// Transport, crypto and discovery belong to the server package. @mu/ai is
// excluded from these: talking to a provider over HTTP is what it is for.
const TRANSPORT_FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /\bwebsocket\b/i, label: "websocket" },
  { pattern: /\bhandshake\b/i, label: "handshake" },
  { pattern: /\bmdns\b|zeroconf|bonjour/i, label: "service discovery" },
  { pattern: /x25519|chacha20|noise[_ -]?ik/i, label: "handshake primitive" },
  { pattern: /node:net|node:tls|node:http|node:dgram/, label: "socket import" },
  { pattern: /\bpairing\b/i, label: "pairing" },
];

// Session storage in core is allowed to touch fs via an injected store only; the
// file-backed store lives outside the kernel. No exceptions list yet — add here
// with justification if one becomes necessary.

// cli → server → protocol → sdk → core → ai. Each package may import only from
// packages to its right; anything not listed may not be imported at all.
const LAYERS: Record<string, string[]> = {
  "packages/ai": [],
  "packages/core": ["@mu/ai"],
  "packages/sdk": ["@mu/ai", "@mu/core"],
  "packages/protocol": ["@mu/ai", "@mu/core", "mu"],
  "packages/server": ["@mu/ai", "@mu/core", "mu", "@mu/protocol"],
};

const WORKSPACE_IMPORT = /from\s+["'](@mu\/[a-z-]+|mu)(?:\/[^"']*)?["']/g;

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
  const rules =
    dir === "packages/core/src" ? [...FORBIDDEN, ...TRANSPORT_FORBIDDEN] : [...FORBIDDEN];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { pattern, label } of rules) {
        if (pattern.test(line)) {
          console.error(`${file}:${i + 1} forbidden concept "${label}": ${line.trim()}`);
          failures++;
        }
      }
    });
  }
}

for (const [pkg, allowed] of Object.entries(LAYERS)) {
  let files: string[];
  try {
    files = [...walk(join(pkg, "src"))];
  } catch {
    continue;
  }
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(WORKSPACE_IMPORT)) {
      const specifier = match[1] as string;
      if (allowed.includes(specifier)) continue;
      console.error(`${file} imports "${specifier}", which is upstream of ${pkg}`);
      failures++;
    }
  }
}

// A runtime dependency in @mu/protocol reaches the mobile app's bundle through
// the published package; only what mu already ships may appear here.
const PROTOCOL_ALLOWED_DEPS = new Set(["@mu/core", "mu", "zod"]);
try {
  const manifest = JSON.parse(readFileSync("packages/protocol/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (PROTOCOL_ALLOWED_DEPS.has(name)) continue;
    console.error(`packages/protocol/package.json adds runtime dependency "${name}"`);
    failures++;
  }
} catch {
  // The package does not exist yet.
}

if (failures > 0) {
  console.error(`\nkernel purity check FAILED: ${failures} hit(s)`);
  process.exit(1);
}
console.log("kernel purity check passed");
