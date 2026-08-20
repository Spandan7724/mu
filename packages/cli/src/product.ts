import { readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type {
  ProductArgResult,
  ProductDescriptor,
  ProductLaunchContext,
  ProfileRequest,
} from "@mu/cli-runtime";
import { helpText, usageLine } from "@mu/cli-runtime";
import { bashTool } from "@mu/profile-coding";
import { codingRenderers, formatCwdForFooter } from "@mu/tui";
import cliPackage from "../package.json";
import { modelCatalogCachePath, userConfigPath } from "./data.ts";
import { DEFAULT_PROFILE, profileOptionsFromArgs, resolveProfile } from "./profiles.ts";

// Product-owned argv beyond the neutral surface flags.
export interface CodingProductOptions {
  purgeData: boolean;
  workerSessionId?: string | undefined;
  workerOwnershipToken?: string | undefined;
}

export type CodingProductCommand =
  | "agents"
  | "agents-supervisor"
  | "agents-worker"
  | "self-update"
  | "self-uninstall";

// Shallow file listing for the `@` popup — bounded so a huge tree cannot
// stall a keystroke.
const MENTION_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next"]);

export function mentionCandidates(root: string, query: string): { label: string }[] {
  const out: { label: string }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || out.length >= 50) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || MENTION_SKIP.has(name)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
        else {
          const rel = relative(root, full);
          if (query.length === 0 || rel.includes(query)) out.push({ label: rel });
        }
      } catch {
        // unreadable entry — skip
      }
      if (out.length >= 50) return;
    }
  };
  walk(root, 0);
  return out;
}

export function formatTerminalTitle(cwd: string): string {
  return `${CODING_COMMAND} - ${basename(cwd) || cwd}`;
}

const CODING_COMMAND = "mu";

function parseCodingArgs(
  claimed: readonly (readonly string[])[],
): ProductArgResult<CodingProductOptions> {
  const options: CodingProductOptions = { purgeData: false };
  const errors: string[] = [];
  let command: CodingProductCommand | undefined;

  for (const group of claimed) {
    const [token, value] = group;
    switch (token) {
      case "agents":
        command = "agents";
        break;
      case "__agents-supervisor":
        command = "agents-supervisor";
        break;
      case "__agents-worker":
        command = "agents-worker";
        break;
      case "self":
        if (value === "update") command = "self-update";
        else if (value === "uninstall") command = "self-uninstall";
        else errors.push('self expects "update" or "uninstall"');
        break;
      case "--purge":
        options.purgeData = true;
        break;
      case "--session-id":
        options.workerSessionId = value;
        if (!value) errors.push("--session-id requires a value");
        break;
      case "--ownership-token":
        options.workerOwnershipToken = value;
        if (!value) errors.push("--ownership-token requires a value");
        break;
    }
  }

  return { options, ...(command ? { command } : {}), errors };
}

export const codingProduct: ProductDescriptor<CodingProductOptions> = {
  id: "mu",
  displayName: "Mu",
  commandName: CODING_COMMAND,
  version: cliPackage.version,
  tagline: "a general-purpose, extensible AI agent",
  bannerTagline: "a general-purpose, extensible agent",
  defaultProfile: DEFAULT_PROFILE,
  createProfile: (request: ProfileRequest<CodingProductOptions>) =>
    resolveProfile(
      request.name ?? DEFAULT_PROFILE,
      profileOptionsFromArgs({ noInstructions: request.noInstructions }),
    ),
  argTokens: {
    agents: 0,
    "__agents-supervisor": 0,
    "__agents-worker": 0,
    self: 1,
    "--purge": 0,
    "--session-id": 1,
    "--ownership-token": 1,
  },
  parseProductArgs: parseCodingArgs,
  help: {
    usage: [
      usageLine("mu agents", "manage several ordinary sessions"),
      usageLine("mu self update", "update a global npm, Bun, or GitHub-release install"),
      usageLine("mu self uninstall", "remove a global npm, Bun, or GitHub-release install"),
    ],
    options: [
      "      --purge              with self uninstall, also delete ~/.mu (config, credentials, sessions)",
    ],
  },
  data: {
    configFile: (home) => userConfigPath(home),
    modelCatalogFile: (home) => modelCatalogCachePath(home),
  },
  renderers: codingRenderers,
  capabilities: {
    directShell: {
      toolName: "bash",
      fallbackTool: (context: ProductLaunchContext) => bashTool({ root: context.cwd }),
    },
    fileMentions: {
      candidates: (query: string, context: ProductLaunchContext) =>
        mentionCandidates(context.cwd, query),
    },
  },
  transcriptPrefix: CODING_COMMAND,
  terminalTitle: (context) => formatTerminalTitle(context.cwd),
  footerLocation: (context) =>
    formatCwdForFooter(context.cwd, process.env.HOME ?? process.env.USERPROFILE),
};

export const HELP_TEXT = helpText(codingProduct);
