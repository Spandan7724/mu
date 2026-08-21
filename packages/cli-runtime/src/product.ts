// The composition contract between a concrete product and the neutral runtime.
// Everything a surface would otherwise have to know about a product — its name,
// its profile, its data locations, its renderers, its extra commands, its
// optional capabilities — arrives through this descriptor. The runtime may
// compose a product; it may never import or branch on one.
import type { AnyTool, Command, Profile, ToolRenderer } from "@mu/core";
import type { ToolRendererFn } from "@mu/tui";

// A directory this invocation is scoped to. The runtime forwards it to
// extension/skill/markdown-command discovery and to the product, and never
// interprets it itself.
export interface ProductLaunchContext {
  cwd: string;
}

// The `!` escape in the interactive surface and the RPC `shell` op. A product
// without this capability has no direct execution at all, rather than silently
// inheriting someone else's shell.
export interface DirectShellAdapter {
  // Preferred tool name to reuse from the active profile's toolset.
  toolName: string;
  // Used when the active profile registers no tool by that name.
  fallbackTool: (context: ProductLaunchContext) => AnyTool;
}

// The `@` popup. A product with nothing to mention omits it and the popup
// stays empty instead of walking an irrelevant directory tree.
export interface FileMentionAdapter {
  candidates: (
    query: string,
    context: ProductLaunchContext,
  ) => { label: string; description?: string }[];
}

export interface ProductCapabilities {
  directShell?: DirectShellAdapter;
  fileMentions?: FileMentionAdapter;
}

// Where this product keeps its own state. No path literal lives in the runtime.
export interface ProductDataNamespace {
  configFile: (home?: string) => string;
  modelCatalogFile: (home?: string) => string;
  // Root for file-backed sessions; undefined keeps the SDK default.
  sessionRoot?: (home?: string) => string | undefined;
}

// Extra lines merged into the neutral help text.
export interface ProductHelp {
  usage?: readonly string[];
  options?: readonly string[];
  // Rendered after `--permission-mode`. The runtime knows the flag exists but not
  // what a product's modes are called, so an omitted list prints no enumeration
  // rather than another product's vocabulary.
  permissionModes?: readonly string[];
}

// Neutral flags the runtime already parsed, handed to the product so it can
// derive its own profile options from them.
export interface ProfileRequest<Options = unknown> {
  // `--profile <name>`; undefined selects the product's own default.
  name: string | undefined;
  cwd: string;
  noInstructions: boolean;
  // Whatever this product's own argv parser produced.
  options: Options;
}

export interface ProductArgResult<Options> {
  options: Options;
  // Selects a product-owned mode; the runtime hands control back to the
  // product's entry point instead of starting a surface.
  command?: string;
  errors: string[];
}

export interface ProductCommandContext {
  cwd: string;
}

export interface ProductDescriptor<Options = unknown> {
  id: string;
  displayName: string;
  commandName: string;
  version: string;
  // One line after the command name in `--help`.
  tagline: string;
  // One line beside the agent name in the startup banner; defaults to tagline.
  bannerTagline?: string;
  // Recorded in the session header when no profile is selected at all.
  defaultProfile: string;
  createProfile: (request: ProfileRequest<Options>) => Promise<Profile>;
  // argv tokens this product owns, mapped to the number of following argv
  // entries each consumes. The neutral parser needs the arity to slice argv;
  // it never interprets the tokens.
  argTokens?: Readonly<Record<string, number>>;
  // Receives the claimed token groups in argv order.
  parseProductArgs: (claimed: readonly (readonly string[])[]) => ProductArgResult<Options>;
  help?: ProductHelp;
  data: ProductDataNamespace;
  // Registered into the TUI renderer registry before profile and extension
  // renderers. The runtime registers exactly what it is given.
  renderers?: Readonly<Record<string, ToolRendererFn | ToolRenderer>>;
  capabilities?: ProductCapabilities;
  // Startup diagnostics the product owns; profile diagnostics arrive from the
  // profile itself and are reported the same way.
  diagnostics?: (context: ProductLaunchContext) => Promise<string[]> | string[];
  commands?: (context: ProductCommandContext) => Command[];
  // Prefix of a generated `/export` filename.
  transcriptPrefix?: string;
  // Terminal title and footer location string. Both are opaque to the runtime.
  terminalTitle?: (context: ProductLaunchContext) => string;
  footerLocation?: (context: ProductLaunchContext) => string | undefined;
}

export function diagnosticPrefix(product: Pick<ProductDescriptor, "commandName">): string {
  return `${product.commandName}: `;
}
