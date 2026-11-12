// Checks that a Chrome window on a hidden workspace still renders once mu restarts its
// frames (Tab.ensureRendering). Hyprland only:
//   bun packages/profiles/browser/scripts/settle-probe/hidden-window.ts [chrome flags...]
// Adds an in-memory window rule (class muprobe → workspace 99, silent), launches a
// throwaway Chrome there, and counts animation frames before and after the kick.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectCdp } from "../../src/cdp/connection.ts";

const PORT = 9_329;
const hyprctl = (...args: string[]) => Bun.spawnSync(["hyprctl", ...args]).stdout.toString();
hyprctl(
  "eval",
  'hl.window_rule({ name = "mu-probe", match = { class = "^muprobe$" }, workspace = "99 silent" })',
);
const dir = mkdtempSync(join(tmpdir(), "mu-hidden-"));
const chrome = [
  "/usr/bin/google-chrome-stable",
  "--class=muprobe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${dir}`,
  ...process.argv.slice(2),
  "about:blank",
].join(" ");
hyprctl("eval", `hl.exec_cmd(${JSON.stringify(chrome)})`);

let socketUrl: string | undefined;
for (let i = 0; i < 75 && !socketUrl; i++) {
  await Bun.sleep(200);
  socketUrl = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    .then(
      (response) => response.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>,
    )
    .then((targets) => targets.find((target) => target.type === "page")?.webSocketDebuggerUrl)
    .catch(() => undefined);
}
if (!socketUrl) throw new Error("Chrome did not start");
const connection = await connectCdp(socketUrl);
const frames = async () => {
  const result = await connection.send("Runtime.evaluate", {
    expression:
      "new Promise((resolve) => { let n = 0; const tick = () => { n++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(() => resolve(n), 2000); })",
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result.value as number;
};
try {
  await Bun.sleep(1_500);
  const where = (
    JSON.parse(hyprctl("clients", "-j")) as { class: string; workspace: { name: string } }[]
  ).find((client) => client.class === "muprobe")?.workspace.name;
  console.log(`window on workspace ${where} (99 = hidden)`);
  console.log(`frames in 2 s before the kick: ${await frames()}`);
  const started = performance.now();
  await connection.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 1,
    clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
    fromSurface: false,
  });
  console.log(`kick took ${Math.round(performance.now() - started)} ms`);
  console.log(`frames in 2 s after the kick: ${await frames()}`);
} finally {
  await connection.send("Browser.close").catch(() => {});
  await Bun.sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
