import { homedir } from "node:os";
import { join } from "node:path";
import {
  discoverSkills,
  ExtensionHost,
  type LoadMcpConfigOptions,
  type LoadOptions,
  loadExtensions,
  loadMcpApprovals,
  loadMcpConfig,
  mcpExtension,
  projectDirectories,
  skillRoots,
  skillsExtension,
} from "mu";

export interface BuiltInExtensions {
  host: ExtensionHost;
  warnings: string[];
}

export interface BuiltInOptions {
  home?: string;
  // Project skill folders and project-defined MCP servers (off for profiles without a project).
  project?: boolean;
  // Start mu-configured MCP servers in the background (tests turn this off).
  warmMcp?: boolean;
  mcpCacheDir?: string | false;
}

// Built-ins are ordinary extensions registered on the same host user code can
// supply. Keeping this in the CLI means filesystem discovery and subprocess
// connections never leak into the kernel.
export async function loadBuiltInExtensions(
  cwd: string,
  host: ExtensionHost = new ExtensionHost(),
  configOptions: Omit<LoadMcpConfigOptions, "projectDir"> = {},
  extensionOptions: Omit<LoadOptions, "projectDir"> = {},
  options: BuiltInOptions = {},
): Promise<BuiltInExtensions> {
  const warnings: string[] = [];
  const home = options.home ?? configOptions.home ?? homedir();
  const project = options.project !== false;
  const projectDirs = project ? await projectDirectories(cwd, { home }) : [];
  const projectDir = projectDirs.at(-1);

  const roots = skillRoots({ home, projectDirs });
  const catalog = await discoverSkills(roots);
  warnings.push(...catalog.warnings.map((warning) => `skill ${warning}`));
  await host.register(skillsExtension({ roots, catalog }));

  const config = await loadMcpConfig({
    ...configOptions,
    home,
    ...(projectDir ? { projectDir } : {}),
  });
  // Problems in other agents' configs are listed by /mcp rather than at every startup.
  const userFile = configOptions.userFile ?? join(home, ".mu", "config.json");
  const muFiles = new Set([
    userFile,
    ...(projectDir ? [join(projectDir, ".mu", "config.json")] : []),
  ]);
  warnings.push(
    ...config.errors
      .filter((error) => muFiles.has(error.file))
      .map((error) => `${error.file}: ${error.message}`),
  );
  const logStart = host.logs.length;
  await host.register(
    mcpExtension({
      servers: config.servers,
      shadowed: config.shadowed,
      errors: config.errors,
      ...(projectDir ? { projectDir } : {}),
      approvals: await loadMcpApprovals(join(home, ".mu", "mcp", "approvals.json")),
      userFile,
      home,
      ...(options.mcpCacheDir !== undefined ? { cacheDir: options.mcpCacheDir } : {}),
      ...(options.warmMcp !== undefined ? { warm: options.warmMcp } : {}),
    }),
  );
  warnings.push(...host.logs.slice(logStart));

  const user = await loadExtensions(host, { ...extensionOptions, projectDir: cwd });
  warnings.push(...user.failed.map(({ file, error }) => `extension ${file}: ${error}`));

  return { host, warnings };
}
