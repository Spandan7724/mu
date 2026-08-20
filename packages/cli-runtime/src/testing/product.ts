// A minimal non-coding product used to prove the runtime seam is real: it
// composes the interactive, headless, and RPC surfaces without importing a
// coding tool, prompt, command, renderer, or UI module. It is test scaffolding,
// not a shipped product.
import { join } from "node:path";
import { type AnyTool, type Profile, type SessionEnvironment, textResult } from "mu";
import type { ProductArgResult, ProductDescriptor } from "../product.ts";

export interface EchoProductOptions {
  // Recorded verbatim into the session header environment.
  label?: string | undefined;
}

export interface EchoProfileOptions {
  dataDir: string;
  label?: string | undefined;
  environment?: SessionEnvironment | undefined;
}

const echoTool: AnyTool = {
  name: "echo",
  description: "Repeat the supplied text back.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  execute: async (_id, args) => textResult(String((args as { text?: unknown }).text ?? "")),
};

export function echoProfile(options: EchoProfileOptions): Profile {
  return {
    name: "echo",
    toolset: [echoTool],
    promptFor: () => [{ id: "identity", text: "You repeat text." }],
    permissionDefaults: [{ permission: "*", pattern: "*", action: "allow" }],
    permissionModes: [
      {
        id: "default",
        label: "default",
        description: "Ask before anything with an effect",
        rules: [],
      },
      {
        id: "yolo",
        label: "full access",
        description: "Never ask",
        tone: "unrestricted",
        rules: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    ],
    defaultPermissionMode: "default",
    environment: () => ({
      surface: "echo",
      ...(options.label ? { label: options.label } : {}),
      ...(options.environment ?? {}),
    }),
    scope: () => "echo",
  };
}

export interface EchoProductConfig {
  dataDir: string;
  environment?: SessionEnvironment | undefined;
}

export function echoProduct(
  config: EchoProductConfig,
): ProductDescriptor<EchoProductOptions> & { profileCalls: number } {
  const descriptor = {
    id: "echo",
    displayName: "Echo",
    commandName: "echo-agent",
    version: "9.9.9",
    tagline: "a product with no domain at all",
    defaultProfile: "echo",
    profileCalls: 0,
    createProfile: async (request) => {
      descriptor.profileCalls += 1;
      return echoProfile({
        dataDir: config.dataDir,
        ...(request.options?.label ? { label: request.options.label } : {}),
        ...(config.environment ? { environment: config.environment } : {}),
      });
    },
    argTokens: { "--label": 1 },
    parseProductArgs: (claimed): ProductArgResult<EchoProductOptions> => {
      const options: EchoProductOptions = {};
      const errors: string[] = [];
      for (const [token, value] of claimed) {
        if (token !== "--label") continue;
        if (!value) errors.push("--label requires a value");
        else options.label = value;
      }
      return { options, errors };
    },
    help: { options: ["      --label <text>       record a label in the session environment"] },
    data: {
      configFile: () => join(config.dataDir, "config.json"),
      modelCatalogFile: () => join(config.dataDir, "models.json"),
      sessionRoot: () => join(config.dataDir, "sessions"),
    },
    transcriptPrefix: "echo",
  } as ProductDescriptor<EchoProductOptions> & { profileCalls: number };
  return descriptor;
}
