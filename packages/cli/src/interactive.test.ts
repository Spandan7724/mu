import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPermissionMode, formatResumeHint, registerProductRenderers } from "@mu/cli-runtime";
import { CODING_PERMISSION_MODES } from "@mu/profile-coding";
import { RendererRegistry, stripAnsi } from "@mu/tui";
import { codingProduct, formatTerminalTitle, mentionCandidates } from "./product.ts";

test("terminal title identifies mu and the working directory", () => {
  expect(formatTerminalTitle("/home/test/code/mu_testing")).toBe("mu - mu_testing");
  expect(formatTerminalTitle("/")).toBe("mu - /");
  expect(codingProduct.terminalTitle?.({ cwd: "/home/test/code/mu_testing" })).toBe(
    "mu - mu_testing",
  );
});

test("session close hint is a directly runnable resume command", () => {
  expect(
    formatResumeHint("019fa562-3975-71e6-b7a1-ed63c54f1fac", "none", codingProduct.commandName),
  ).toBe("  To resume this session: mu --resume 019fa562-3975-71e6-b7a1-ed63c54f1fac");
});

describe("coding permission mode notice", () => {
  const modeFor = (id: string) => {
    const mode = CODING_PERMISSION_MODES.find((candidate) => candidate.id === id);
    if (!mode) throw new Error(`no such mode: ${id}`);
    return mode;
  };

  test("each mode is coloured by how it moves the gate", () => {
    // Loosening reads green, opening fully reads red, restricting reads blue,
    // and the baseline keeps mu's own accent.
    expect(formatPermissionMode(modeFor("accept-edits"), "truecolor")).toContain(
      "74;222;128maccept edits",
    );
    expect(formatPermissionMode(modeFor("yolo"), "truecolor")).toContain("[1;31mfull access");
    expect(formatPermissionMode(modeFor("plan-readonly"), "truecolor")).toContain(
      "96;165;250mplan (read-only)",
    );
    expect(formatPermissionMode(modeFor("default"), "truecolor")).toContain("177;249;223mdefault");
  });

  test("the mode stays legible without colour", () => {
    // Bold carries the distinction when hue cannot, and NO_COLOR keeps the text.
    for (const mode of CODING_PERMISSION_MODES) {
      expect(formatPermissionMode(mode, "truecolor")).toContain("[1;");
      expect(formatPermissionMode(mode, "none")).toBe(
        `  permissions set to ${mode.label} · this session`,
      );
    }
  });
});

describe("coding capabilities", () => {
  test("the @ popup lists workspace files and skips build output", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-mentions-"));
    await writeFile(join(root, "alpha.ts"), "");
    await writeFile(join(root, "beta.md"), "");
    await Bun.write(join(root, "node_modules", "ignored.ts"), "");
    await Bun.write(join(root, ".hidden", "ignored.ts"), "");

    const all = mentionCandidates(root, "").map((item) => item.label);
    expect(all).toContain("alpha.ts");
    expect(all).toContain("beta.md");
    expect(all.some((label) => label.includes("node_modules"))).toBe(false);
    expect(all.some((label) => label.includes(".hidden"))).toBe(false);
    expect(mentionCandidates(root, "alpha").map((item) => item.label)).toEqual(["alpha.ts"]);
    expect(codingProduct.capabilities?.fileMentions?.candidates("beta", { cwd: root })).toEqual([
      { label: "beta.md" },
    ]);
  });
});

describe("coding tool renderers", () => {
  test("the product's renderers still own the coding tool cells", () => {
    const registry = new RendererRegistry();
    registerProductRenderers(registry, codingProduct.renderers);
    const lines = registry
      .render(
        {
          toolName: "read",
          args: { path: "src/a.ts" },
          result: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "x" }],
            details: { lines: 3 },
            isError: false,
            timestamp: 1,
          },
        },
        { width: 80, depth: "none" },
      )
      .map(stripAnsi);

    expect(lines[0]).toContain("read");
    expect(lines[0]).toContain("src/a.ts");
    expect(lines[0]).toContain("3 lines");
  });
});
