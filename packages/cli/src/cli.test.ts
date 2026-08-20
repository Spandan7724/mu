import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "@mu/cli-runtime";
import { modelCatalogCachePath, userConfigPath } from "./data.ts";
import { codingProduct, HELP_TEXT } from "./product.ts";

const args = (argv: string[]) => parseArgs(argv, codingProduct);

// The pre-B1 `mu` command line, asserted through the coding product descriptor
// rather than a hard-coded parser. Any drift here is a change users would see.
describe("mu command line", () => {
  test("defaults to the interactive app", () => {
    expect(args([]).mode).toBe("tui");
    expect(args([]).productCommand).toBeUndefined();
  });

  test("agents is an explicit command and does not change plain mu", () => {
    expect(args(["agents"]).productCommand).toBe("agents");
    expect(args(["agents"]).mode).toBe("product");
    expect(args([]).mode).toBe("tui");
    expect(HELP_TEXT).toContain("mu agents");
  });

  test("the managed supervisor and worker keep their private tokens", () => {
    expect(args(["__agents-supervisor"]).productCommand).toBe("agents-supervisor");
    const worker = args([
      "__agents-worker",
      "--session-id",
      "s1",
      "--ownership-token",
      "t1",
    ]);
    expect(worker.productCommand).toBe("agents-worker");
    expect(worker.product.workerSessionId).toBe("s1");
    expect(worker.product.workerOwnershipToken).toBe("t1");
    expect(worker.errors).toEqual([]);
    expect(args(["__agents-worker", "--session-id"]).errors[0]).toContain("requires a value");
    expect(args(["__agents-worker", "--ownership-token"]).errors[0]).toContain("requires a value");
  });

  test("self update selects the package updater", () => {
    expect(args(["self", "update"]).productCommand).toBe("self-update");
    expect(args(["self", "update"]).errors).toEqual([]);
    expect(args(["self"]).errors[0]).toContain('expects "update" or "uninstall"');
    expect(HELP_TEXT).toContain("mu self update");
  });

  test("self uninstall selects the uninstaller, and --purge opts into deleting ~/.mu", () => {
    expect(args(["self", "uninstall"]).productCommand).toBe("self-uninstall");
    expect(args(["self", "uninstall"]).product.purgeData).toBe(false);
    expect(args(["self", "uninstall", "--purge"]).product.purgeData).toBe(true);
    expect(args(["self", "uninstall", "--purge"]).errors).toEqual([]);
    expect(args(["self", "remove"]).errors[0]).toContain('expects "update" or "uninstall"');
    expect(HELP_TEXT).toContain("mu self uninstall");
    expect(HELP_TEXT).toContain("--purge");
  });

  test("the neutral surface flags still parse through the coding product", () => {
    const parsed = args([
      "-p",
      "do the thing",
      "--json",
      "--model",
      "anthropic/claude-opus-5",
      "--profile",
      "coding",
      "--resume",
      "session-id",
      "--max-turns",
      "5",
      "--max-cost",
      "0.5",
      "--permission-mode",
      "plan-readonly",
      "--no-instructions",
    ]);
    expect(parsed).toMatchObject({
      mode: "headless",
      prompt: "do the thing",
      json: true,
      model: "anthropic/claude-opus-5",
      profile: "coding",
      resumeSessionId: "session-id",
      maxTurns: 5,
      maxCostUsd: 0.5,
      permissionMode: "plan-readonly",
      noInstructions: true,
      errors: [],
    });
    expect(args(["--allow-all"]).allowAll).toBe(true);
    expect(args(["--rpc"]).mode).toBe("rpc");
    expect(args(["--help"]).mode).toBe("help");
    expect(args(["-v"]).mode).toBe("version");
    expect(args(["--nope"]).errors[0]).toContain("Unknown flag");
  });

  // The exact pre-B1 help block. It is the most visible part of the CLI and
  // the first thing an accidental branding regression would break.
  test("the help text is unchanged from the pre-B1 command", () => {
    expect(HELP_TEXT).toBe(`mu — a general-purpose, extensible AI agent

Usage:
  mu                       start the interactive terminal app
  mu --resume <session>    resume an interactive session
  mu -p "<prompt>"         run one prompt and print the result
  mu --rpc                 newline-delimited JSON: events out, ops in
  mu agents                manage several ordinary sessions
  mu self update           update a global npm, Bun, or GitHub-release install
  mu self uninstall        remove a global npm, Bun, or GitHub-release install

Options:
  -p, --print <prompt>     headless one-shot mode
      --json               stream events as JSON (headless mode)
      --model <ref>        model to use, e.g. anthropic/claude-opus-5
      --profile <name>     profile to load (default: coding)
      --resume <session>   resume an earlier session (interactive, headless, or RPC)
      --max-turns <n>      stop after n turns
      --max-cost <usd>     stop once the run costs this much
      --permission-mode <mode>
                           default | accept-edits | plan-readonly | yolo
      --allow-all          alias for --permission-mode yolo
      --no-instructions    disable global and project instruction loading
      --purge              with self uninstall, also delete ~/.mu (config, credentials, sessions)
  -h, --help               show this help
  -v, --version            show the version
`);
  });
});

describe("coding product identity", () => {
  test("branding and the data namespace are the pre-B1 values", () => {
    expect(codingProduct.commandName).toBe("mu");
    expect(codingProduct.defaultProfile).toBe("coding");
    expect(codingProduct.transcriptPrefix).toBe("mu");
    expect(userConfigPath("/users/test")).toBe(join("/users/test", ".mu", "config.json"));
    expect(modelCatalogCachePath("/users/test")).toBe(join("/users/test", ".mu", "models.json"));
    expect(codingProduct.data.configFile("/users/test")).toBe(userConfigPath("/users/test"));
    expect(codingProduct.data.modelCatalogFile("/users/test")).toBe(
      modelCatalogCachePath("/users/test"),
    );
  });

  test("direct shell and file mentions are coding capabilities, not runtime built-ins", () => {
    expect(codingProduct.capabilities?.directShell?.toolName).toBe("bash");
    expect(codingProduct.capabilities?.directShell?.fallbackTool({ cwd: process.cwd() }).name).toBe(
      "bash",
    );
    expect(codingProduct.capabilities?.fileMentions).toBeDefined();
  });

  test("the coding tool renderers are supplied by the product", () => {
    expect(Object.keys(codingProduct.renderers ?? {})).toContain("read");
    expect(Object.keys(codingProduct.renderers ?? {})).toContain("bash");
  });
});
