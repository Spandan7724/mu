import { describe, expect, test } from "bun:test";
import type { ToolResultMessage } from "@mu/core";
import { codingRenderers, RendererRegistry, type ToolRenderInfo } from "./registry.ts";
import { stripAnsi } from "./style.ts";
import { stringWidth } from "./width.ts";

const registry = new RendererRegistry();
registry.registerAll(codingRenderers);
const ctx = { width: 80, depth: "none" as const };

const SCRIPT = `python3 - <<'EOF'
import pathlib
p = pathlib.Path("src/a.ts"); p.write_text(p.read_text().replace("old", "new"))
EOF`;

const changedFiles = [
  {
    path: "src/a.ts",
    added: 1,
    removed: 1,
    hunks: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3 +3 @@",
      "-const value = old;",
      "+const value = new;",
    ],
  },
  { path: "src/b.ts", added: 2, removed: 0, hunks: [], hunksOmitted: true },
];

function bash(
  command: string,
  output: string,
  details: Record<string, unknown>,
  expanded = false,
): ToolRenderInfo {
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "b1",
    toolName: "bash",
    content: [{ type: "text", text: output }],
    details: { command, durationMs: 120, ...details },
    isError: details.exitCode !== 0,
    timestamp: 1,
  };
  return { toolName: "bash", args: { command }, result, expanded };
}

const render = (info: ToolRenderInfo) => registry.render(info, ctx).map(stripAnsi);
const note = "\n\n[changed 2 files: src/a.ts (+1 -1), src/b.ts (+2 -0)]";

describe("a bash command that changed files", () => {
  test("its row ends with the file count and line totals", () => {
    const [header] = render(bash(SCRIPT, `done${note}`, { exitCode: 0, changedFiles }));
    expect(header).toBe("    ran python3 - <<'EOF' … · ✓ 120ms · 2 files +3 −1");
  });

  test("a long command is cut so the totals stay on the row", () => {
    const command = `bunx biome format --write ${"packages/very/long/path/".repeat(4)}`;
    const [header = ""] = render(bash(command, `ok${note}`, { exitCode: 0, changedFiles }));
    expect(header).toEndWith("· 2 files +3 −1");
    expect(stringWidth(header)).toBeLessThanOrEqual(ctx.width);
  });

  test("a failed command still shows what it changed", () => {
    const [header] = render(bash(SCRIPT, `AssertionError${note}`, { exitCode: 1, changedFiles }));
    expect(header).toBe("    ran python3 - <<'EOF' … · ✗ exit 1 · 120ms · 2 files +3 −1");
  });

  test("expanded, it shows the output without the model's note, then each file's diff", () => {
    const lines = render(bash(SCRIPT, `done${note}`, { exitCode: 0, changedFiles }, true));
    const body = lines.slice(SCRIPT.split("\n").length).map((line) => line.trim());
    expect(body).toEqual([
      "done",
      "src/a.ts · +1 −1",
      "3 − const value = old;",
      "3 + const value = new;",
      "src/b.ts · +2 −0",
      "diff too large to keep in the session",
    ]);
  });

  test("collapsed output leaves out the model's note", () => {
    const lines = render(bash("make", `built${note}`, { exitCode: 0, changedFiles }));
    expect(lines.join("\n")).not.toContain("[changed");
  });

  test("a command that changed nothing renders as before", () => {
    const lines = render(bash("bun test", "1 pass", { exitCode: 0 }));
    expect(lines[0]).toBe("    ran bun test · ✓ 120ms");
  });

  test("the commands group counts distinct files and totals across its commands", () => {
    const summary = registry.activitySummary(
      "command",
      [
        bash(SCRIPT, `done${note}`, { exitCode: 0, changedFiles }),
        bash("bun test", "1 pass", { exitCode: 0 }),
        bash("fmt", "ok", {
          exitCode: 0,
          changedFiles: [{ path: "src/a.ts", added: 1, removed: 1, hunks: [] }],
        }),
      ],
      "none",
    );
    expect(stripAnsi(summary)).toBe("Ran 3 commands, changed 2 files +4 −2");
  });
});
