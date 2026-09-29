import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type PermissionRule } from "@mu/core";
import { browserProfile } from "../index.ts";

const home = () => mkdtempSync(join(tmpdir(), "mu-browser-perm-"));

async function rulesFor(mode: string, options: Parameters<typeof browserProfile>[0] = {}) {
  const profile = await browserProfile({ home: home(), ...options });
  const selected = profile.permissionModes?.find((candidate) => candidate.id === mode);
  if (!selected) throw new Error(`no mode ${mode}`);
  return { profile, rules: [...profile.permissionDefaults, ...selected.rules] as PermissionRule[] };
}

const check = (rules: PermissionRule[], tool: string, scope: string, pattern = "example.com") =>
  evaluate(rules, [tool, scope], pattern);

describe("browser permission modes", () => {
  test("default mode is the default: interact freely, ask for commits, secrets, uploads and scripts", async () => {
    const { profile, rules } = await rulesFor("default");
    expect(profile.defaultPermissionMode).toBe("default");
    expect(check(rules, "snapshot", "browser:observe")).toBe("allow");
    expect(check(rules, "navigate", "browser:navigate")).toBe("allow");
    expect(check(rules, "click", "browser:interact")).toBe("allow");
    expect(check(rules, "click", "browser:commit")).toBe("ask");
    expect(check(rules, "type", "browser:secret")).toBe("ask");
    expect(check(rules, "upload", "browser:upload")).toBe("ask");
    expect(check(rules, "evaluate", "browser:script")).toBe("ask");
    expect(evaluate(rules, "notes", "*")).toBe("allow");
    expect(evaluate(rules, "todo", "*")).toBe("allow");
    expect(evaluate(rules, "some_mcp_tool", "*")).toBe("ask");
  });

  test("supervised asks for navigation and interaction; read-only denies interaction", async () => {
    const supervised = (await rulesFor("supervised")).rules;
    expect(check(supervised, "navigate", "browser:navigate")).toBe("ask");
    expect(check(supervised, "click", "browser:interact")).toBe("ask");
    expect(check(supervised, "find", "browser:observe")).toBe("allow");
    const readOnly = (await rulesFor("read-only")).rules;
    expect(check(readOnly, "navigate", "browser:navigate")).toBe("allow");
    expect(check(readOnly, "click", "browser:interact")).toBe("deny");
    expect(check(readOnly, "click", "browser:commit")).toBe("deny");
    expect(check(readOnly, "read_page", "browser:observe")).toBe("allow");
  });

  test("autonomous allows everything but host rules still hold in every mode", async () => {
    const { profile, rules } = await rulesFor("autonomous", { blockedHosts: ["*.evil.test"] });
    expect(profile.permissionModes?.find((mode) => mode.id === "autonomous")?.tone).toBe(
      "unrestricted",
    );
    expect(check(rules, "click", "browser:commit")).toBe("allow");
    expect(check(rules, "evaluate", "browser:script")).toBe("allow");
    expect(check(rules, "navigate", "browser:navigate", "www.evil.test")).toBe("deny");
    const allowList = (
      await rulesFor("default", { allowedHosts: ["*.example.com", "example.com"] })
    ).rules;
    expect(check(allowList, "navigate", "browser:navigate", "docs.example.com")).toBe("allow");
    expect(check(allowList, "navigate", "browser:navigate", "other.org")).toBe("deny");
  });

  test("always-allow is host-scoped and persists across sessions", async () => {
    const dir = home();
    const first = await browserProfile({ home: dir });
    await first.rememberPermission?.("browser:commit", "mail.google.com");
    await first.rememberPermission?.("browser:commit", "mail.google.com");
    const second = await browserProfile({ home: dir });
    const rules = [...second.permissionDefaults];
    expect(check(rules, "click", "browser:commit", "mail.google.com")).toBe("allow");
    expect(check(rules, "click", "browser:commit", "shop.example.com")).toBe("ask");
    expect(
      second.permissionDefaults.filter((candidate) => candidate.pattern === "mail.google.com"),
    ).toHaveLength(1);
  });
});
