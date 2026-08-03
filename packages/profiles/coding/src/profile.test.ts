import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "@mu/core";
import { codingEnvironment, discoverContextFiles, environmentMessage } from "./context.ts";
import { codingProfile } from "./index.ts";
import {
  CODING_PERMISSION_DEFAULTS,
  CODING_PERMISSION_MODES,
  layerPermissions,
  loadProjectConfig,
  rememberAllow,
} from "./permissions.ts";
import { codingPrompt } from "./prompts.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-profile-"));
}

describe("codingProfile", () => {
  test("ships the documented toolset", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const names = profile.toolset.map((t) => t.name).sort();
    expect(names).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "ls",
      "read",
      "task_detach",
      "task_kill",
      "task_list",
      "task_output",
      "task_write_stdin",
      "todo",
      "write",
    ]);
  });

  test("read-only tools are marked concurrency-safe, mutating ones are not", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const byName = new Map(profile.toolset.map((t) => [t.name, t]));
    for (const safe of ["read", "ls", "glob", "grep"]) {
      expect(byName.get(safe)?.isConcurrencySafe?.({})).toBe(true);
    }
    for (const unsafe of ["write", "edit"]) {
      expect(byName.get(unsafe)?.isConcurrencySafe).toBeUndefined();
    }
    expect(byName.get("bash")?.isConcurrencySafe?.({ command: "rg --files" })).toBe(true);
    expect(byName.get("bash")?.isConcurrencySafe?.({ command: "npm test" })).toBe(false);
  });

  test("carryover reports the files the session touched", async () => {
    const root = await scratch();
    await writeFile(join(root, "a.txt"), "hi");
    const profile = await codingProfile({ root });
    profile.fileState.markRead(join(root, "a.txt"));
    profile.fileState.markWritten(join(root, "b.txt"));

    const carryover = profile.carryoverExtractor?.([]) as {
      readFiles: string[];
      modifiedFiles: string[];
    };
    expect(carryover.readFiles).toContain(join(root, "a.txt"));
    expect(carryover.modifiedFiles).toContain(join(root, "b.txt"));
  });

  test("scope is a stable key derived from the session root", async () => {
    const root = await scratch();
    const profile = await codingProfile({ root });
    const scope = await profile.scope?.();
    expect(scope).not.toContain("/");
    expect(scope).toBe(await (await codingProfile({ root })).scope?.());
  });
});

describe("permission defaults", () => {
  test("reads and searches are allowed without asking", () => {
    for (const tool of ["read", "ls", "glob", "grep", "todo"]) {
      expect(evaluate(CODING_PERMISSION_DEFAULTS, tool, "anything")).toBe("allow");
    }
  });

  test("writes and execution ask", () => {
    for (const tool of ["write", "edit", "bash"]) {
      expect(evaluate(CODING_PERMISSION_DEFAULTS, tool, "anything")).toBe("ask");
    }
  });

  test("proven shell inspection is allowed without allowing ordinary bash", () => {
    expect(evaluate(CODING_PERMISSION_DEFAULTS, ["bash", "bash:inspect"], "rg --files")).toBe(
      "allow",
    );
    expect(evaluate(CODING_PERMISSION_DEFAULTS, "bash", "npm test")).toBe("ask");
  });

  test("task inspection is allowed while task mutation still asks", () => {
    expect(evaluate(CODING_PERMISSION_DEFAULTS, "task_output", '{"taskId":"t1"}')).toBe("allow");
    expect(evaluate(CODING_PERMISSION_DEFAULTS, "task_list", "{}")).toBe("allow");
    expect(evaluate(CODING_PERMISSION_DEFAULTS, "task_write_stdin", '{"taskId":"t1"}')).toBe("ask");
    expect(evaluate(CODING_PERMISSION_DEFAULTS, "task_kill", '{"taskId":"t1"}')).toBe("ask");
  });

  test("named permission modes layer over configured defaults", () => {
    const rules = (id: string) => [
      ...CODING_PERMISSION_DEFAULTS,
      ...(CODING_PERMISSION_MODES.find((mode) => mode.id === id)?.rules ?? []),
    ];

    expect(evaluate(rules("accept-edits"), "write", "{}")).toBe("allow");
    expect(evaluate(rules("accept-edits"), "bash", "{}")).toBe("ask");
    expect(evaluate(rules("plan-readonly"), "read", "{}")).toBe("allow");
    expect(evaluate(rules("plan-readonly"), "write", "{}")).toBe("deny");
    expect(evaluate(rules("plan-readonly"), "bash", "{}")).toBe("deny");
    expect(evaluate(rules("plan-readonly"), ["bash", "bash:inspect"], "git status --short")).toBe(
      "allow",
    );
    expect(evaluate(rules("yolo"), "bash", "{}")).toBe("allow");
  });

  test("project config layers over the profile defaults", () => {
    const layered = layerPermissions(CODING_PERMISSION_DEFAULTS, [
      { permission: "bash", pattern: "npm test*", action: "allow" },
    ]);
    expect(evaluate(layered, "bash", "npm test")).toBe("allow");
    expect(evaluate(layered, "bash", "rm -rf /")).toBe("ask");
  });

  test("bash projects its command for permission matching", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const bash = profile.toolset.find((candidate) => candidate.name === "bash");

    expect(bash?.permissionPattern?.({ command: "npm test", description: "Run tests" })).toBe(
      "npm test",
    );
  });

  test("bash derives inspection scope only for proven foreground inspection", async () => {
    const profile = await codingProfile({ root: await scratch() });
    const bash = profile.toolset.find((candidate) => candidate.name === "bash");

    expect(bash?.permissionScope?.({ command: "rg --files | head -20" })).toBe("bash:inspect");
    expect(bash?.permissionScope?.({ command: "rg --files > files.txt" })).toBe("bash");
    expect(bash?.permissionScope?.({ command: "rg --files", run_in_background: true })).toBe(
      "bash",
    );
  });

  test("project config is read from .mu/config.json", async () => {
    const root = await scratch();
    await mkdir(join(root, ".mu"), { recursive: true });
    await writeFile(
      join(root, ".mu", "config.json"),
      JSON.stringify({ permissions: [{ permission: "bash", pattern: "ls*", action: "allow" }] }),
    );
    const config = await loadProjectConfig(root);
    expect(config.permissions?.[0]?.pattern).toBe("ls*");

    const profile = await codingProfile({ root });
    expect(evaluate(profile.permissionDefaults, "bash", "ls -la")).toBe("allow");
    expect(evaluate(profile.permissionDefaults, "bash", "curl evil.com")).toBe("ask");
  });

  test("a malformed config is ignored rather than fatal", async () => {
    const root = await scratch();
    await mkdir(join(root, ".mu"), { recursive: true });
    await writeFile(join(root, ".mu", "config.json"), "{ not json");
    expect(await loadProjectConfig(root)).toEqual({});
  });

  test("always-allow persists to the project config", async () => {
    const root = await scratch();
    await rememberAllow(root, "bash", "npm test*");

    const config = await loadProjectConfig(root);
    expect(config.permissions).toEqual([
      { permission: "bash", pattern: "npm test*", action: "allow" },
    ]);

    // Recording the same rule twice must not duplicate it.
    await rememberAllow(root, "bash", "npm test*");
    expect((await loadProjectConfig(root)).permissions?.length).toBe(1);

    // And it takes effect on the next session.
    const profile = await codingProfile({ root });
    expect(evaluate(profile.permissionDefaults, "bash", "npm test -- --watch")).toBe("allow");
  });

  test("remembering preserves other config keys", async () => {
    const root = await scratch();
    await mkdir(join(root, ".mu"), { recursive: true });
    await writeFile(join(root, ".mu", "config.json"), JSON.stringify({ model: "openai/gpt-5.1" }));
    await rememberAllow(root, "write", "*");
    const config = await loadProjectConfig(root);
    expect(config.model).toBe("openai/gpt-5.1");
    expect(config.permissions?.length).toBe(1);
  });
});

describe("project context discovery", () => {
  test("walks up collecting context files, nearest last", async () => {
    const root = await scratch();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root rules");
    await writeFile(join(nested, "AGENTS.md"), "package rules");

    const found = await discoverContextFiles(nested, root);
    expect(found.length).toBe(2);
    expect(found[0]).toBe(join(root, "AGENTS.md"));
    expect(found[1]).toBe(join(nested, "AGENTS.md"));
  });

  test("CLAUDE.md is discovered too", async () => {
    const root = await scratch();
    await writeFile(join(root, "CLAUDE.md"), "conventions");
    const found = await discoverContextFiles(root, root);
    expect(found.some((f) => f.endsWith("CLAUDE.md"))).toBe(true);
  });

  test("no context files is not an error", async () => {
    const root = await scratch();
    expect(await discoverContextFiles(root, root)).toEqual([]);
  });

  test("context enters as typed messages, never the system prompt", async () => {
    const root = await scratch();
    await writeFile(join(root, "AGENTS.md"), "always use tabs");
    const profile = await codingProfile({ root });

    const initial = (await profile.contextMessages?.()) ?? [];
    const messages = [
      ...initial,
      ...((await profile.refreshContext?.(initial, { sessionId: "test-session" })) ?? []),
    ];
    expect(messages.length).toBeGreaterThanOrEqual(2); // environment + AGENTS.md
    for (const message of messages) expect(message.role).toBe("custom");
    const joined = messages
      .map((m) => (m.role === "custom" && m.content[0]?.type === "text" ? m.content[0].text : ""))
      .join("\n");
    expect(joined).toContain("always use tabs");

    // The system prompt must not carry any of it.
    const prompt = profile
      .promptFor("anthropic/claude-opus-5")
      .map((s) => s.text)
      .join("\n");
    expect(prompt).not.toContain("always use tabs");
  });
});

describe("environment", () => {
  test("reports the directory and platform", async () => {
    const root = await scratch();
    const env = await codingEnvironment(root);
    expect(env.directory).toBe(root);
    expect(env.platform).toBe(process.platform);
    expect(env.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("renders as a custom message", async () => {
    const message = environmentMessage({ directory: "/x", platform: "linux" });
    expect(message.role).toBe("custom");
    if (message.role === "custom") {
      expect(message.customType).toBe("environment");
      expect(message.content[0]?.type === "text" && message.content[0].text).toContain("/x");
    }
  });
});

describe("prompts", () => {
  test("the base prompt is model-independent and small", () => {
    const sections = codingPrompt("anthropic/claude-opus-5");
    expect(sections.length).toBe(1);
    expect(sections[0]?.text.split("\n").length).toBeLessThan(40);
  });

  test("the base prompt requires grounded file and line citations", () => {
    const base = codingPrompt("anthropic/claude-opus-5")[0]?.text ?? "";
    expect(base).toContain("workspace-relative `path:line`");
    expect(base).toContain("1-based starting");
    expect(base).toContain("never invent a line number");
  });

  test("GPT-family models get an extra literal-instruction section", () => {
    const sections = codingPrompt("openai/gpt-5.1");
    expect(sections.length).toBe(2);
    expect(sections[1]?.text).toContain("explicit and literal");
  });

  test("Gemini gets its own variant", () => {
    const sections = codingPrompt("google/gemini-2.5-pro");
    expect(sections.length).toBe(2);
    expect(sections[1]?.text).toContain("exact surrounding text");
  });

  test("all variants share the same first section, so the cached prefix is stable", () => {
    const base = codingPrompt("anthropic/claude-opus-5")[0]?.text;
    expect(codingPrompt("openai/gpt-5.1")[0]?.text).toBe(base);
    expect(codingPrompt("google/gemini-2.5-pro")[0]?.text).toBe(base);
  });
});
