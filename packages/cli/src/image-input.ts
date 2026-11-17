import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasImageExtension } from "mu";

// Splits pasted text the way terminals write dropped files: quoted, with
// backslash-escaped spaces, or as file:// URLs, separated by whitespace.
export function splitPastedPaths(text: string, platform = process.platform): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  const chars = [...text.trim()];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] as string;
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && platform !== "win32" && i + 1 < chars.length) {
      current += chars[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

function pathFromToken(token: string, cwd: string, home: string | undefined): string | undefined {
  if (token.startsWith("file://")) {
    try {
      return fileURLToPath(token);
    } catch {
      return undefined;
    }
  }
  if (home && (token === "~" || token.startsWith("~/"))) return resolve(home, token.slice(2));
  return isAbsolute(token) ? token : resolve(cwd, token);
}

// The image files a paste names, when it names nothing else: a dropped or
// pasted path to a missing file or a non-image leaves the paste as text.
export function pastedImagePaths(
  text: string,
  cwd: string,
  home = process.env.HOME ?? process.env.USERPROFILE,
): string[] | undefined {
  if (text.length > 8192 || text.trim().length === 0) return undefined;
  const paths: string[] = [];
  for (const token of splitPastedPaths(text)) {
    const path = pathFromToken(token, cwd, home);
    if (!path || !hasImageExtension(path) || !existsSync(path)) return undefined;
    try {
      if (!statSync(path).isFile()) return undefined;
    } catch {
      return undefined;
    }
    paths.push(path);
  }
  return paths.length > 0 ? paths : undefined;
}

const LIST_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 5000;

// undefined: the command is missing or failed.
async function run(command: string[], timeoutMs = READ_TIMEOUT_MS): Promise<Buffer | undefined> {
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [output, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      child.exited,
    ]);
    clearTimeout(timer);
    return code === 0 ? Buffer.from(output) : undefined;
  } catch {
    return undefined;
  }
}

const PREFERRED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function preferredType(listing: Buffer): string | undefined {
  const types = listing
    .toString("utf8")
    .split(/\r?\n/)
    .map((type) => type.trim());
  return PREFERRED_TYPES.find((type) => types.includes(type));
}

// null: the clipboard tool answered and holds no image; undefined: it is not available.
async function viaTool(
  list: string[],
  read: (type: string) => string[],
): Promise<Buffer | null | undefined> {
  const listing = await run(list, LIST_TIMEOUT_MS);
  if (!listing) return undefined;
  const type = preferredType(listing);
  if (!type) return null;
  const data = await run(read(type));
  return data && data.length > 0 ? data : null;
}

const POWERSHELL_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$img = [System.Windows.Forms.Clipboard]::GetImage()",
  "if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }",
].join("; ");

async function viaPowerShell(executable: string): Promise<Buffer | null | undefined> {
  const output = await run([executable, "-NoProfile", "-STA", "-Command", POWERSHELL_SCRIPT]);
  if (!output) return undefined;
  const base64 = output.toString("utf8").trim();
  return base64 ? Buffer.from(base64, "base64") : null;
}

async function viaOsascript(): Promise<Buffer | null | undefined> {
  const output = await run(["osascript", "-e", "the clipboard as «class PNGf»"]);
  if (!output) return null;
  const hex = /«data PNGf([0-9A-Fa-f]*)»/.exec(output.toString("utf8"))?.[1];
  return hex ? Buffer.from(hex, "hex") : null;
}

function isWsl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

// The clipboard's image bytes; null when it holds none, undefined when no
// clipboard tool could be reached.
export async function readClipboardImage(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer | null | undefined> {
  if (platform === "darwin") return viaOsascript();
  if (platform === "win32") return viaPowerShell("powershell");
  let image: Buffer | null | undefined;
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") {
    image = await viaTool(["wl-paste", "--list-types"], (type) => [
      "wl-paste",
      "--type",
      type,
      "--no-newline",
    ]);
  }
  if (image === undefined && env.DISPLAY) {
    image = await viaTool(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"], (type) => [
      "xclip",
      "-selection",
      "clipboard",
      "-t",
      type,
      "-o",
    ]);
  }
  // WSL screenshots land on the Windows clipboard only.
  if (!image && isWsl(env)) image = (await viaPowerShell("powershell.exe")) ?? image;
  return image;
}

export function clipboardToolHint(platform = process.platform): string {
  if (platform === "linux") return "install wl-clipboard (Wayland) or xclip (X11)";
  return "the clipboard could not be read";
}
