import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { CdpError } from "../cdp/connection.ts";

export interface Size {
  width: number;
  height: number;
}

export interface BrowserEndpoint {
  wsUrl: string;
  launched: boolean;
  pid?: number;
}

export interface LaunchOptions {
  path: string;
  userDataDir: string;
  headless: boolean;
  viewport: Size;
  args?: string[] | undefined;
  url?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export const LAUNCH_LOG = "mu-browser.log";

// Never --enable-automation: it changes the fingerprint and makes Google refuse sign-in.
export function managedArgs(options: {
  userDataDir: string;
  headless: boolean;
  viewport: Size;
  args?: string[] | undefined;
}): string[] {
  return [
    `--user-data-dir=${options.userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-search-engine-choice-screen",
    `--window-size=${options.viewport.width},${options.viewport.height}`,
    ...(options.headless ? ["--headless=new"] : []),
    ...(options.args ?? []).filter((arg) => arg !== "--enable-automation"),
  ];
}

export function ensureProfileDir(userDataDir: string): void {
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(userDataDir, 0o700);
}

export function parseDevToolsActivePort(content: string): string | undefined {
  const [rawPort, rawPath] = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const port = Number(rawPort);
  if (!rawPath || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return `ws://127.0.0.1:${port}${rawPath}`;
}

export function readDevToolsActivePort(userDataDir: string): string | undefined {
  try {
    return parseDevToolsActivePort(readFileSync(join(userDataDir, "DevToolsActivePort"), "utf8"));
  } catch {
    return undefined;
  }
}

function logTail(userDataDir: string): string {
  try {
    const text = readFileSync(join(userDataDir, LAUNCH_LOG), "utf8").trim();
    return text ? `\n${text.slice(-1500)}` : "";
  } catch {
    return "";
  }
}

// Detached so the logged-in window outlives mu (BD13).
export async function launchBrowser(options: LaunchOptions): Promise<BrowserEndpoint> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (options.signal?.aborted) throw new CdpError("aborted", "launch", "aborted");
  ensureProfileDir(options.userDataDir);
  rmSync(join(options.userDataDir, "DevToolsActivePort"), { force: true });
  const log = openSync(join(options.userDataDir, LAUNCH_LOG), "w", 0o600);
  const child = spawn(
    options.path,
    [...managedArgs(options), ...(options.url ? [options.url] : [])],
    { detached: true, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  child.unref();

  return new Promise<BrowserEndpoint>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, wsUrl?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
      options.signal?.removeEventListener("abort", onAbort);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) {
        if (child.exitCode === null) killBrowserProcess(child.pid);
        reject(error);
      } else {
        resolve({
          wsUrl: wsUrl as string,
          launched: true,
          ...(child.pid ? { pid: child.pid } : {}),
        });
      }
    };
    const check = () => {
      const wsUrl = readDevToolsActivePort(options.userDataDir);
      if (wsUrl) finish(undefined, wsUrl);
    };
    const onExit = (code: number | null) =>
      finish(
        new Error(
          `Browser exited before it was ready (code ${code ?? "signal"}).${logTail(options.userDataDir)}`,
        ),
      );
    const onError = (error: Error) =>
      finish(new Error(`Could not start browser: ${error.message}`));
    const onAbort = () => finish(new CdpError("aborted", "launch", "aborted"));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Browser did not open a debugging endpoint within ${timeoutMs} ms.${logTail(options.userDataDir)}`,
          ),
        ),
      timeoutMs,
    );
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(options.userDataDir, (_event, name) => {
        if (name === "DevToolsActivePort") check();
      });
    } catch {}
    // Backstop for filesystems where watch events are unreliable.
    const poll = setInterval(check, 100);
    child.on("exit", onExit);
    child.on("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

export function killBrowserProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
