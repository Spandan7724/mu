import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command, CommandContext } from "@mu/core";
import { BrowserArtifactStore } from "../artifacts/store.ts";
import type { ApplicantProfile } from "../contracts/applicant.ts";
import { documentSummary } from "../contracts/documents.ts";
import type { BrowserDriverFactory } from "../drivers/factory.ts";
import { createFakeBrowserDriver } from "../drivers/fake/driver.ts";
import { resolveBrowserProfileOptions } from "../profile/options.ts";
import { BrowserTakeoverSession } from "../renderers/takeover.ts";
import { BrowserRuntime } from "../runtime/runtime.ts";
import { sampleDocument, sampleFact, sampleReceipt } from "../testing/samples.ts";
import { BROWSER_RESUME_COMMAND, browserCommands } from "./index.ts";

const factory: BrowserDriverFactory = async () => ({
  driver: createFakeBrowserDriver(),
  ownership: "attached",
  description: "a deterministic fake chrome",
  dispose: async () => {},
});

function runtime(): BrowserRuntime {
  return new BrowserRuntime({
    factory,
    connection: "extension",
    browser: "chrome",
    dataRoot: "/tmp/mu-browser-commands",
  });
}

interface Harness {
  commands: Map<string, Command>;
  run: (name: string, args?: string) => Promise<string>;
  takeover: BrowserTakeoverSession;
}

function harness(overrides: Partial<Parameters<typeof browserCommands>[0]> = {}): Harness {
  const takeover = new BrowserTakeoverSession();
  const list = browserCommands({
    runtime: runtime(),
    options: resolveBrowserProfileOptions({ allowedOrigins: ["https://jobs.example.com"] }),
    dataRoot: "/tmp/mu-browser-commands",
    takeover,
    ...overrides,
  });
  const commands = new Map(list.map((command) => [command.name, command]));
  return {
    commands,
    takeover,
    run: async (name, args = "") => {
      const command = commands.get(name);
      if (command === undefined) throw new Error(`no /${name} command`);
      const context = {
        args,
        inject: () => {},
        print: () => {},
        getModel: () => "test",
        setModel: () => {},
      } satisfies CommandContext;
      const result = await command.run(context);
      return result?.message ?? "";
    },
  };
}

describe("every capability DESIGN names is discoverable", () => {
  const { commands } = harness();

  test("the commands exist under their own names", () => {
    for (const name of [
      "browser",
      "tabs",
      "takeover",
      BROWSER_RESUME_COMMAND,
      "disconnect",
      "documents",
      "profile",
      "receipt",
    ]) {
      expect(commands.has(name)).toBe(true);
    }
  });

  test("each has a description, so /help lists what it does", () => {
    for (const command of commands.values()) {
      expect(command.description.length).toBeGreaterThan(10);
    }
  });
});

describe("/browser answers with real connection state", () => {
  test("status names the connection, the phase and the allowed origins", async () => {
    const message = await harness().run("browser");
    expect(message).toContain("chrome (extension)");
    expect(message).toContain("not connected");
    expect(message).toContain("https://jobs.example.com");
    expect(message).toContain("detaches without closing your browser");
  });

  test("connect opens the connection and reports it", async () => {
    const message = await harness().run("browser", "connect");
    expect(message).toContain("ready");
    expect(message).toContain("connected and accepting actions");
  });

  test("an unknown subcommand answers with its usage rather than silence", async () => {
    expect(await harness().run("browser", "wat")).toContain("Usage: /browser");
  });
});

describe("/tabs lists what Mu controls", () => {
  test("it names each tab and which one is active", async () => {
    const message = await harness().run("tabs");
    expect(message).toContain("controlled tab");
    expect(message).toContain("active");
    expect(message).toContain("/tabs <id>");
  });

  test("/browser tabs is the same answer", async () => {
    const message = await harness().run("browser", "tabs");
    expect(message).toContain("controlled tab");
  });
});

describe("takeover and resume are reachable from the keyboard alone", () => {
  test("takeover pauses, says what to do, and names how to come back", async () => {
    const app = harness();
    await app.run("browser", "connect");
    const message = await app.run("takeover", "login");
    expect(message).toContain("you have control of the browser");
    expect(message).toContain("waiting for you in the browser");
    expect(message).toContain(`/${BROWSER_RESUME_COMMAND}`);
    expect(app.takeover.active).toBe(true);
    expect(app.takeover.mayIssuePageMutation()).toBe(false);
  });

  test("a credential takeover never asks for the secret in the composer", async () => {
    const app = harness();
    await app.run("browser", "connect");
    const message = await app.run("takeover", "password");
    expect(message).toContain("never here");
    expect(message).toContain("screenshots are suspended");
  });

  test("resume re-observes and says every earlier reference is stale", async () => {
    const app = harness();
    await app.run("browser", "connect");
    await app.run("takeover", "login");
    const message = await app.run(BROWSER_RESUME_COMMAND);
    expect(message).toContain("resumed");
    expect(message).toContain("stale");
    expect(message).toContain("preserved");
    expect(app.takeover.active).toBe(false);
    expect(app.takeover.mayIssuePageMutation()).toBe(true);
  });

  test("/browser resume is the same capability", async () => {
    const app = harness();
    await app.run("browser", "connect");
    await app.run("browser", "takeover");
    expect(await app.run("browser", "resume")).toContain("resumed");
  });

  test("status says the session is paused while it is", async () => {
    const app = harness();
    await app.run("browser", "connect");
    await app.run("takeover", "captcha");
    expect(await app.run("browser")).toContain("you have the browser");
  });

  test("a second takeover reports the first rather than replacing it", async () => {
    const app = harness();
    await app.run("browser", "connect");
    await app.run("takeover", "login");
    expect(await app.run("takeover", "mfa")).toContain("already paused");
  });
});

describe("/disconnect ends access without deleting browser data", () => {
  test("an attached browser is detached, not closed", async () => {
    const app = harness();
    await app.run("browser", "connect");
    const message = await app.run("disconnect");
    expect(message).toContain("Detached");
    expect(message).toContain("no browser data was removed");
  });
});

describe("/documents answers from the launch-directory set", () => {
  test("with nothing available it says where files come from", async () => {
    const message = await harness().run("documents");
    expect(message).toContain("No uploadable documents");
    expect(message).toContain("launch directory");
  });

  test("it names the id, type, size and digest, and never a path", async () => {
    const document = sampleDocument();
    const app = harness({
      sources: {
        documents: async () => ({ documents: [documentSummary(document)], problems: [] }),
      },
    });
    const message = await app.run("documents");
    expect(message).toContain(document.id);
    expect(message).toContain("resume.pdf");
    expect(message).toContain("application/pdf");
    expect(message).toContain("12.1 kB");
    expect(message).toContain("sha256 aaaaaaaaaaaa");
    expect(message).not.toContain(document.path);
    expect(message).toContain("never sees a path");
  });

  test("a document that could not be authorized is reported with its reason", async () => {
    const app = harness({
      sources: {
        documents: async () => ({
          documents: [],
          problems: [{ path: "/tmp/missing.pdf", message: "no file at missing.pdf" }],
        }),
      },
    });
    const message = await app.run("documents");
    expect(message).toContain("not available");
    expect(message).toContain("no file at missing.pdf");
  });

  test("it authorizes the configured paths for real", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-browser-docs-"));
    try {
      const path = join(root, "resume.txt");
      await writeFile(path, "Ada Lovelace\nEngineer\n");
      const app = harness({
        options: resolveBrowserProfileOptions({ documents: [path], allowedOrigins: [] }),
      });
      const message = await app.run("documents");
      expect(message).toContain("resume.txt");
      expect(message).toContain("text/plain");
      expect(message).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("/profile shows coverage and provenance, never a sensitive value", () => {
  test("with nothing configured it says what to configure", async () => {
    const message = await harness().run("profile");
    expect(message).toContain("No applicant profile is configured");
    expect(message).toContain("--applicant-profile");
  });

  test("it reports facts, provenance and unanswered policy answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-browser-profile-"));
    try {
      const path = join(root, "applicant.json");
      const profile: ApplicantProfile = {
        version: 1,
        facts: [
          sampleFact(),
          sampleFact({
            id: "fact-salary",
            field: "desired_salary",
            value: "185000",
            sensitivity: "sensitive",
          }),
        ],
        policy: {},
        documents: [],
      };
      await writeFile(path, JSON.stringify(profile));
      const app = harness({
        options: resolveBrowserProfileOptions({ applicantProfile: path, allowedOrigins: [] }),
      });
      const message = await app.run("profile");
      expect(message).toContain("full_name");
      expect(message).toContain("Ada Lovelace");
      expect(message).toContain("you told Mu");
      expect(message).toContain("desired_salary");
      expect(message).not.toContain("185000");
      expect(message).toContain("withheld");
      expect(message).toContain("unanswered policy answers");
      expect(message).toContain("work authorization");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unreadable profile is reported, not silently empty", async () => {
    const app = harness({
      options: resolveBrowserProfileOptions({
        applicantProfile: "/tmp/mu-browser-does-not-exist.json",
        allowedOrigins: [],
      }),
    });
    expect(await app.run("profile")).toContain("could not read the applicant profile");
  });
});

describe("/receipt reads what was actually written", () => {
  test("with nothing written it says where receipts will go", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-browser-receipts-"));
    try {
      const store = new BrowserArtifactStore({ root });
      const app = harness({ sources: { receipts: () => store } });
      const message = await app.run("receipt");
      expect(message).toContain("No receipts yet");
      expect(message).toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("it lists recent receipts and opens one by id", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-browser-receipts-"));
    try {
      const store = new BrowserArtifactStore({ root });
      await store.writeReceipt(sampleReceipt());
      const app = harness({ sources: { receipts: () => store } });
      const listed = await app.run("receipt");
      expect(listed).toContain("receipt-1");
      expect(listed).toContain("confirmed");
      const one = await app.run("receipt", "receipt-1");
      expect(one).toContain("the site confirmed the action");
      expect(one).toContain("Full name");
      expect(one).toContain("resume.pdf");
      expect(one).toContain("APP-4711");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an uncertain receipt says Mu will not repeat the action", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-browser-receipts-"));
    try {
      const store = new BrowserArtifactStore({ root });
      await store.writeReceipt(
        sampleReceipt({ id: "receipt-2", status: "unknown", externalId: undefined }),
      );
      const app = harness({ sources: { receipts: () => store } });
      const message = await app.run("receipt", "receipt-2");
      expect(message).toContain("connection was lost");
      expect(message).toContain("will not repeat this action");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unknown id is reported rather than guessed at", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-browser-receipts-"));
    try {
      const app = harness({ sources: { receipts: () => new BrowserArtifactStore({ root }) } });
      expect(await app.run("receipt", "nope")).toContain("No receipt nope");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
