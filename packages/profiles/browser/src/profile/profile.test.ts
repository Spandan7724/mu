import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSessionEnvironment } from "@mu/core";
import { fakeFactory } from "../drivers/index.ts";
import {
  browserArtifactsDir,
  browserConfigPath,
  browserDataDir,
  browserProfilesDir,
  browserSessionsDir,
  ensureBrowserDataRoot,
} from "./data.ts";
import { resolveBrowserProfileOptions } from "./options.ts";
import { BROWSER_PERMISSION_MODES } from "./permissions.ts";
import { browserProfile } from "./profile.ts";
import { BROWSER_STATUS_TOOL } from "./tools.ts";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-browser-home-"));
}

describe("profile options", () => {
  test("the safe defaults are the extension bridge, a visible browser and no extra origins", () => {
    const resolved = resolveBrowserProfileOptions();
    expect(resolved.connection).toBe("extension");
    expect(resolved.browser).toBe("chrome");
    expect(resolved.headless).toBe(false);
    expect(resolved.allowedOrigins).toEqual([]);
    expect(resolved.userDataDir).toBeUndefined();
  });

  test("extension mode refuses headless and refuses to own a profile directory", () => {
    expect(() => resolveBrowserProfileOptions({ headless: true })).toThrow();
    expect(() => resolveBrowserProfileOptions({ userDataDir: "work" })).toThrow();
  });

  test("persistent mode names a Mu-owned profile and defaults it", () => {
    expect(resolveBrowserProfileOptions({ connection: "persistent" }).userDataDir).toBe("default");
    expect(
      resolveBrowserProfileOptions({ connection: "persistent", userDataDir: "work" }).userDataDir,
    ).toBe("work");
  });

  test("allowed origins are normalized and deduplicated, and a non-origin is rejected", () => {
    expect(
      resolveBrowserProfileOptions({
        allowedOrigins: ["https://jobs.example.com/apply", "https://jobs.example.com"],
      }).allowedOrigins,
    ).toEqual(["https://jobs.example.com"]);
    expect(() => resolveBrowserProfileOptions({ allowedOrigins: ["not a url"] })).toThrow();
    expect(() => resolveBrowserProfileOptions({ allowedOrigins: ["file:///etc"] })).toThrow();
  });
});

describe("the browser data namespace is isolated from the coding product", () => {
  test("every path is under ~/.mu/browser and never collides with ~/.mu/config.json", () => {
    const home = "/home/tester";
    expect(browserDataDir(home)).toBe(join(home, ".mu", "browser"));
    expect(browserConfigPath(home)).not.toBe(join(home, ".mu", "config.json"));
    for (const path of [
      browserConfigPath(home),
      browserSessionsDir(home),
      browserProfilesDir(home),
      browserArtifactsDir(home),
    ]) {
      expect(path.startsWith(browserDataDir(home))).toBe(true);
    }
  });

  test("the data root and its subdirectories are created 0700", async () => {
    const home = await tempHome();
    try {
      const root = await ensureBrowserDataRoot(home);
      for (const directory of [
        root,
        browserSessionsDir(home),
        browserProfilesDir(home),
        browserArtifactsDir(home),
      ]) {
        const mode = (await stat(directory)).mode & 0o777;
        if (process.platform !== "win32") expect(mode).toBe(0o700);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("browserProfile", () => {
  test("it satisfies the profile contract with browser-only behaviour", async () => {
    const home = await tempHome();
    try {
      const profile = await browserProfile({ home, factory: fakeFactory() });
      expect(profile.name).toBe("browser");
      expect(profile.toolset.map((tool) => tool.name)).toEqual([BROWSER_STATUS_TOOL]);
      expect(profile.promptFor("anthropic/claude-opus-5")[0]?.text).toContain("mu-browser");
      expect(profile.permissionModes?.map((mode) => mode.id)).toEqual(
        BROWSER_PERMISSION_MODES.map((mode) => mode.id),
      );
      expect(profile.defaultPermissionMode).toBe("confirm-submit");
      expect(Object.keys(profile.renderers ?? {})).toEqual([BROWSER_STATUS_TOOL]);
      expect(profile.commands?.map((command) => command.name).sort()).toEqual([
        "browser",
        "disconnect",
        "resume-browser",
        "tabs",
        "takeover",
      ]);
      await profile.runtime.shutdown();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("it supplies no checkpoint provider, because a submitted form cannot be undone", async () => {
    const home = await tempHome();
    try {
      const profile = await browserProfile({ home, factory: fakeFactory() });
      expect(profile.checkpointProvider).toBeUndefined();
      await profile.runtime.shutdown();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("no coding tool, prompt or command reaches the browser profile", async () => {
    const home = await tempHome();
    try {
      const profile = await browserProfile({ home, factory: fakeFactory() });
      const names = new Set([
        ...profile.toolset.map((tool) => tool.name),
        ...(profile.commands ?? []).map((command) => command.name),
      ]);
      for (const coding of ["bash", "read", "write", "edit", "ls", "todo", "instructions"]) {
        expect(names.has(coding)).toBe(false);
      }
      const prompt = profile
        .promptFor("anthropic/claude-opus-5")
        .map((section) => section.text)
        .join("\n");
      expect(prompt).not.toContain("codebase");
      await profile.runtime.shutdown();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("the environment is bounded, browser-specific and free of secrets", async () => {
    const home = await tempHome();
    try {
      const profile = await browserProfile({
        home,
        factory: fakeFactory(),
        allowedOrigins: ["https://jobs.example.com"],
        documents: ["/documents/resume.pdf"],
      });
      const environment = await profile.environment?.();
      expect(() => normalizeSessionEnvironment(environment)).not.toThrow();
      expect(environment).toMatchObject({
        surface: "browser",
        connection: "extension",
        browser: "chrome",
        headless: "false",
        documents: "1",
        allowedOrigins: "https://jobs.example.com",
      });
      // A document path is a runtime detail; only its count is session metadata.
      expect(JSON.stringify(environment)).not.toContain("resume.pdf");
      await profile.runtime.shutdown();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("an extension token is recorded as configured, never as a value", async () => {
    const home = await tempHome();
    try {
      const { BrowserSecret } = await import("../contracts/secret.ts");
      const profile = await browserProfile({
        home,
        factory: fakeFactory(),
        extensionToken: new BrowserSecret("tok-secret-value"),
      });
      const environment = await profile.environment?.();
      expect(environment?.extensionToken).toBe("configured");
      expect(JSON.stringify(environment)).not.toContain("tok-secret-value");
      await profile.runtime.shutdown();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("the status tool opens the connection and reports the real phase", async () => {
    const home = await tempHome();
    try {
      const profile = await browserProfile({ home, factory: fakeFactory() });
      const [tool] = profile.toolset;
      const result = await tool?.execute("call-1", {}, new AbortController().signal);
      const text = (result?.content ?? [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      expect(text).toContain("chrome (extension) ready");
      expect(text).toContain("detach without closing it");
      expect(profile.runtime.status().phase).toBe("ready");
      await profile.runtime.shutdown();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a profile with no driver configured reports why rather than pretending", async () => {
    const home = await tempHome();
    try {
      const profile = await browserProfile({ home });
      const [tool] = profile.toolset;
      const result = await tool?.execute("call-1", {}, new AbortController().signal);
      const text = (result?.content ?? [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      expect(text).toContain("No browser driver is configured");
      expect(profile.runtime.status().phase).toBe("failed");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("/browser and /disconnect report the connection and detach without closing", async () => {
    const home = await tempHome();
    try {
      const profile = await browserProfile({ home, factory: fakeFactory() });
      const context = {
        args: "connect",
        inject: () => {},
        print: () => {},
        getModel: () => "fake/fake-1",
        setModel: () => {},
      };
      const commands = profile.commands ?? [];
      const browser = commands.find((command) => command.name === "browser");
      const connected = await browser?.run(context);
      expect((connected as { message: string }).message).toContain("chrome (extension) ready");
      const disconnect = commands.find((command) => command.name === "disconnect");
      const ended = await disconnect?.run({ ...context, args: "" });
      expect((ended as { message: string }).message).toContain("Nothing was closed");
      expect(profile.runtime.status().phase).toBe("disconnected");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("carryover is plain JSON with labels and origins only", async () => {
    const home = await tempHome();
    try {
      const profile = await browserProfile({
        home,
        factory: fakeFactory(),
        allowedOrigins: ["https://jobs.example.com"],
      });
      const carryover = profile.carryoverExtractor?.([]) as Record<string, unknown>;
      expect(JSON.parse(JSON.stringify(carryover))).toEqual(carryover);
      expect(carryover.allowedOrigins).toEqual(["https://jobs.example.com"]);
      await profile.runtime.shutdown();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
