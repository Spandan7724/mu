import {
  defaultSkillRoots,
  discoverSkills,
  ExtensionHost,
  type LoadMcpConfigOptions,
  type LoadOptions,
  loadExtensions,
  loadMcpConfig,
  mcpExtension,
  skillsExtension,
} from "mu";

export interface BuiltInExtensions {
  host: ExtensionHost;
  warnings: string[];
}

// Built-ins are ordinary extensions registered on the same host user code can
// supply. Keeping this in the CLI means filesystem discovery and subprocess
// connections never leak into the kernel.
export async function loadBuiltInExtensions(
  projectDir: string,
  host: ExtensionHost = new ExtensionHost(),
  configOptions: Omit<LoadMcpConfigOptions, "projectDir"> = {},
  extensionOptions: Omit<LoadOptions, "projectDir"> = {},
): Promise<BuiltInExtensions> {
  const warnings: string[] = [];

  const skills = await discoverSkills(defaultSkillRoots(projectDir));
  if (skills.length > 0) await host.register(skillsExtension(skills));

  const config = await loadMcpConfig({ ...configOptions, projectDir });
  warnings.push(...config.errors.map((error) => `${error.file}: ${error.message}`));
  if (Object.keys(config.servers).length > 0) {
    const logStart = host.logs.length;
    await host.register(mcpExtension(config.servers));
    warnings.push(...host.logs.slice(logStart));
  }

  const user = await loadExtensions(host, { ...extensionOptions, projectDir });
  warnings.push(...user.failed.map(({ file, error }) => `extension ${file}: ${error}`));

  return { host, warnings };
}
