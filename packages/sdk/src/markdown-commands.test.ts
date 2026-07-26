import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "@mu/core";
import {
  loadMarkdownCommands,
  parseFrontmatter,
  parseMarkdownCommand,
  substituteArguments,
  toCommand,
} from "./markdown-commands.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-cmd-"));
}

async function writeCommand(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), body);
}

describe("frontmatter", () => {
  test("parses scalar and list values", () => {
    const { meta, body } = parseFrontmatter(
      `---\ndescription: Review a file\nmodel: openai/gpt-5.1\nallowed-tools: [read, grep]\n---\nDo the thing.`,
    );
    expect(meta.description).toBe("Review a file");
    expect(meta.model).toBe("openai/gpt-5.1");
    expect(meta["allowed-tools"]).toEqual(["read", "grep"]);
    expect(body).toBe("Do the thing.");
  });

  test("a file without frontmatter is all body", () => {
    const { meta, body } = parseFrontmatter("Just a prompt.");
    expect(meta).toEqual({});
    expect(body).toBe("Just a prompt.");
  });

  test("quotes are stripped", () => {
    const { meta } = parseFrontmatter(`---\ndescription: "Quoted value"\n---\nx`);
    expect(meta.description).toBe("Quoted value");
  });
});

describe("argument substitution", () => {
  test("$ARGUMENTS receives everything after the command", () => {
    expect(substituteArguments("Review $ARGUMENTS please", "src/a.ts src/b.ts")).toBe(
      "Review src/a.ts src/b.ts please",
    );
  });

  test("positionals are substituted individually", () => {
    expect(substituteArguments("Compare $1 with $2", "alpha beta")).toBe("Compare alpha with beta");
  });

  test("a missing positional becomes empty rather than the literal token", () => {
    expect(substituteArguments("Only $1 and $2", "alpha")).toBe("Only alpha and ");
  });

  test("arguments are appended when the body never references them", () => {
    expect(substituteArguments("Summarize the file.", "src/a.ts")).toBe(
      "Summarize the file.\n\nsrc/a.ts",
    );
  });

  test("a body with no placeholders and no arguments is unchanged", () => {
    expect(substituteArguments("Just run it.", "")).toBe("Just run it.");
  });
});

describe("parseMarkdownCommand", () => {
  test("reads name, description, model and allowed tools", () => {
    const command = parseMarkdownCommand(
      "review",
      `---\ndescription: Review code\nmodel: anthropic/claude-opus-5\nallowed-tools: [read, grep]\n---\nReview $ARGUMENTS.`,
    );
    expect(command.name).toBe("review");
    expect(command.description).toBe("Review code");
    expect(command.model).toBe("anthropic/claude-opus-5");
    expect(command.allowedTools).toEqual(["read", "grep"]);
    expect(command.body).toBe("Review $ARGUMENTS.");
  });

  test("a description is synthesized when absent", () => {
    expect(parseMarkdownCommand("plain", "Body only").description).toContain("plain");
  });
});

describe("loading from disk", () => {
  test("loads user commands", async () => {
    const home = await scratch();
    await writeCommand(join(home, "commands"), "greet", "Say hello to $1.");

    const commands = await loadMarkdownCommands({ userDir: join(home, "commands") });
    expect(commands.map((c) => c.name)).toEqual(["greet"]);
  });

  test("project commands override user commands of the same name", async () => {
    const home = await scratch();
    const project = await scratch();
    await writeCommand(join(home, "commands"), "review", "USER version");
    await writeCommand(join(project, ".mu", "commands"), "review", "PROJECT version");

    const commands = await loadMarkdownCommands({
      userDir: join(home, "commands"),
      projectDir: project,
    });
    expect(commands.length).toBe(1);
    expect(commands[0]?.body).toBe("PROJECT version");
  });

  test("missing directories are not an error", async () => {
    expect(await loadMarkdownCommands({ userDir: join(tmpdir(), "definitely-absent-mu") })).toEqual(
      [],
    );
  });

  test("non-markdown files are ignored", async () => {
    const home = await scratch();
    const dir = join(home, "commands");
    await writeCommand(dir, "real", "body");
    await writeFile(join(dir, "notes.txt"), "not a command");
    const commands = await loadMarkdownCommands({ userDir: dir });
    expect(commands.map((c) => c.name)).toEqual(["real"]);
  });
});

describe("registry integration", () => {
  test("a markdown command submits its expanded body as a prompt", async () => {
    const submitted: { prompt: string; model?: string }[] = [];
    const markdown = parseMarkdownCommand(
      "review",
      `---\ndescription: Review\nmodel: openai/gpt-5.1\n---\nReview $ARGUMENTS carefully.`,
    );

    const registry = new CommandRegistry();
    registry.register(
      toCommand(markdown, (prompt, options) =>
        submitted.push({ prompt, ...(options.model ? { model: options.model } : {}) }),
      ),
    );

    const result = await registry.execute("/review src/api.ts", {
      inject: () => {},
      print: () => {},
      getModel: () => "fake/fake-1",
      setModel: () => {},
    });

    expect(result.handled).toBe(true);
    expect(submitted[0]?.prompt).toBe("Review src/api.ts carefully.");
    expect(submitted[0]?.model).toBe("openai/gpt-5.1");
  });

  test("the command appears in the registry listing with its description", async () => {
    const registry = new CommandRegistry();
    registry.register(
      toCommand(
        parseMarkdownCommand("deploy", "---\ndescription: Ship it\n---\nDeploy."),
        () => {},
      ),
    );
    expect(registry.list().map((c) => c.description)).toContain("Ship it");
  });
});
