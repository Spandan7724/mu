import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@mu/core";
import { checkpointDir, checkpointTool } from "./checkpoint.ts";

test("checkpoints are saved to disk, listed newest first and loaded by a later session", async () => {
  const home = mkdtempSync(join(tmpdir(), "mu-checkpoint-"));
  const run = async (args: Record<string, unknown>) => {
    const result = (await checkpointTool(home).execute(
      "k",
      args as never,
      new AbortController().signal,
    )) as ToolResult;
    return {
      result,
      text: result.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    };
  };
  expect((await run({ action: "list" })).text).toBe("no checkpoints saved");
  const saved = await run({
    action: "save",
    name: "job-applications",
    text: "# Jobs\n- [x] Acme: paused at Submit\n- [ ] Globex",
  });
  expect(saved.result.retention?.key).toBe("browser:checkpoint:job-applications");
  expect(readFileSync(join(checkpointDir(home), "job-applications.md"), "utf8")).toContain("Acme");
  expect((await run({ action: "list" })).text).toMatch(
    /- job-applications \(saved \d{4}-\d\d-\d\d \d\d:\d\d\): # Jobs/,
  );
  expect((await run({ action: "load", name: "job-applications" })).text).toContain("- [ ] Globex");
  const missing = await run({ action: "load", name: "nope" });
  expect(missing.result.isError).toBe(true);
  expect((await run({ action: "save", name: "x" })).result.isError).toBe(true);
  rmSync(home, { recursive: true });
});
