import { type FSWatcher, watch } from "node:fs";
import { dirname, resolve } from "node:path";

const REFRESH_DELAY_MS = 25;

async function gitOutput(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
    const output = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? output.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function observeGitBranch(
  cwd: string,
  onChange: (branch: string | undefined) => void,
): Promise<() => void> {
  const initial = await gitOutput(["rev-parse", "--git-path", "HEAD", "--abbrev-ref", "HEAD"], cwd);
  const lines = initial?.split(/\r?\n/);
  const head = lines?.[0];
  let branch = lines?.[1];
  onChange(branch);
  if (!head || !branch) return () => {};

  const headPath = resolve(cwd, head);
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let refreshing = false;
  let refreshAgain = false;

  const refresh = async () => {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    do {
      refreshAgain = false;
      const next = await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      if (!stopped && next !== branch) {
        branch = next;
        onChange(next);
      }
    } while (!stopped && refreshAgain);
    refreshing = false;
  };

  const scheduleRefresh = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
  };

  try {
    // Git commonly replaces HEAD via HEAD.lock, so watch the containing Git
    // directory rather than an inode that disappears during checkout.
    watcher = watch(dirname(headPath), scheduleRefresh);
    watcher.on("error", () => watcher?.close());
  } catch {
    // The initial branch is still useful when the filesystem cannot be watched.
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
