// MCP server configuration: mu's own `mcpServers` plus servers configured for other
// agents (read-only). Project-defined servers run only after the user approves them.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type McpTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export type McpSource = "mu" | "claude" | "codex" | "cursor" | "opencode" | "gemini" | "vscode";
export type McpScope = "user" | "project";
export type McpExposure = "open" | "direct";

export interface McpServerSpec {
  name: string;
  transport: McpTransport;
  source: McpSource;
  scope: McpScope;
  file: string;
  enabled: boolean;
  exposure: McpExposure;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface McpConfigReport {
  servers: McpServerSpec[];
  // Same name or same command/URL as an earlier, higher-precedence server.
  shadowed: McpServerSpec[];
  errors: { file: string; message: string }[];
}

export interface LoadMcpConfigOptions {
  // Project root; project files of every agent are read relative to it.
  projectDir?: string;
  home?: string;
  userFile?: string;
  // Read other agents' configs (default true).
  foreign?: boolean;
}

// Fields a mu entry may set on a same-named server defined elsewhere.
const OVERRIDE_KEYS = [
  "enabled",
  "exposure",
  "description",
  "includeTools",
  "excludeTools",
  "startupTimeoutMs",
  "toolTimeoutMs",
] as const;

type Raw = Record<string, unknown>;
type Entry = Omit<McpServerSpec, "name" | "source" | "scope" | "file">;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
    else return undefined;
  }
  return out;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// Comments and trailing commas, as opencode's .jsonc and VS Code's mcp.json allow.
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function common(raw: Raw): Omit<Entry, "transport"> {
  const includeTools = strings(raw.includeTools);
  const excludeTools = strings(raw.excludeTools);
  const startupTimeoutMs = positive(raw.startupTimeoutMs);
  const toolTimeoutMs = positive(raw.toolTimeoutMs);
  return {
    enabled: raw.enabled !== false,
    exposure: raw.exposure === "direct" ? "direct" : "open",
    ...(typeof raw.description === "string" && raw.description.trim()
      ? { description: raw.description.trim() }
      : {}),
    ...(includeTools ? { includeTools } : {}),
    ...(excludeTools ? { excludeTools } : {}),
    ...(startupTimeoutMs ? { startupTimeoutMs } : {}),
    ...(toolTimeoutMs ? { toolTimeoutMs } : {}),
  };
}

// The `mcpServers` shape shared by mu, Claude Code, Cursor and Gemini.
function standardTransport(raw: Raw, baseDir: string): McpTransport | string {
  const url = typeof raw.httpUrl === "string" ? raw.httpUrl : raw.url;
  if (typeof url === "string" && url.trim()) {
    const headers = raw.headers === undefined ? {} : stringRecord(raw.headers);
    if (!headers) return "headers must map names to strings";
    const type =
      raw.type === "sse" ||
      (typeof raw.url === "string" &&
        raw.httpUrl === undefined &&
        raw.type === undefined &&
        /\/sse\/?$/.test(raw.url))
        ? "sse"
        : "http";
    return { type, url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  if (typeof raw.command === "string" && raw.command.trim()) {
    const args = raw.args === undefined ? [] : strings(raw.args);
    if (!args) return "args must be an array of strings";
    const env = raw.env === undefined ? {} : stringRecord(raw.env);
    if (!env) return "env must map names to strings";
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") return "cwd must be a string";
    const cwd =
      typeof raw.cwd === "string"
        ? isAbsolute(raw.cwd)
          ? raw.cwd
          : resolve(baseDir, raw.cwd)
        : undefined;
    return {
      type: "stdio",
      command: raw.command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  return 'needs "command" (stdio) or "url" (HTTP)';
}

interface Found {
  name: string;
  entry: Entry | string;
}

function standardServers(servers: unknown, baseDir: string): Found[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, raw]) => {
    if (!isRecord(raw)) return { name, entry: "must be an object" };
    const transport = standardTransport(raw, baseDir);
    return {
      name,
      entry: typeof transport === "string" ? transport : { ...common(raw), transport },
    };
  });
}

function codexServers(servers: unknown, baseDir: string): Found[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, raw]) => {
    if (!isRecord(raw)) return { name, entry: "must be a table" };
    const headers: Record<string, string> = { ...(stringRecord(raw.http_headers) ?? {}) };
    for (const [header, variable] of Object.entries(stringRecord(raw.env_http_headers) ?? {})) {
      headers[header] = `\${${variable}}`;
    }
    if (typeof raw.bearer_token_env_var === "string") {
      headers.Authorization = `Bearer \${${raw.bearer_token_env_var}}`;
    }
    const transport = standardTransport(
      {
        command: raw.command,
        args: raw.args,
        env: raw.env,
        cwd: raw.cwd,
        url: raw.url,
        headers,
        type: raw.url ? "http" : undefined,
      },
      baseDir,
    );
    if (typeof transport === "string") return { name, entry: transport };
    const startup = positive(raw.startup_timeout_sec);
    const tool = positive(raw.tool_timeout_sec);
    const includeTools = strings(raw.enabled_tools);
    const excludeTools = strings(raw.disabled_tools);
    return {
      name,
      entry: {
        ...common({ enabled: raw.enabled }),
        transport,
        ...(startup ? { startupTimeoutMs: startup * 1000 } : {}),
        ...(tool ? { toolTimeoutMs: tool * 1000 } : {}),
        ...(includeTools ? { includeTools } : {}),
        ...(excludeTools ? { excludeTools } : {}),
      },
    };
  });
}

// opencode writes `{env:NAME}`; mu expands `${NAME}`.
function opencodeVars(value: string): string {
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
}

function opencodeServers(servers: unknown): Found[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, raw]) => {
    if (!isRecord(raw)) return { name, entry: "must be an object" };
    const enabled = raw.enabled !== false;
    if (raw.type === "remote" && typeof raw.url === "string") {
      const headers = stringRecord(raw.headers) ?? {};
      return {
        name,
        entry: {
          ...common({ enabled }),
          transport: {
            type: "http",
            url: opencodeVars(raw.url),
            ...(Object.keys(headers).length > 0
              ? {
                  headers: Object.fromEntries(
                    Object.entries(headers).map(([k, v]) => [k, opencodeVars(v)]),
                  ),
                }
              : {}),
          },
        },
      };
    }
    const command = strings(raw.command);
    if (raw.type === "local" && command && command.length > 0) {
      const env = stringRecord(raw.environment) ?? {};
      return {
        name,
        entry: {
          ...common({ enabled }),
          transport: {
            type: "stdio",
            command: opencodeVars(command[0] as string),
            ...(command.length > 1 ? { args: command.slice(1).map(opencodeVars) } : {}),
            ...(Object.keys(env).length > 0
              ? {
                  env: Object.fromEntries(
                    Object.entries(env).map(([k, v]) => [k, opencodeVars(v)]),
                  ),
                }
              : {}),
          },
        },
      };
    }
    return { name, entry: 'needs type "local" with a command array or type "remote" with a url' };
  });
}

// Gemini: `url` is SSE, `httpUrl` is streamable HTTP.
function geminiServers(servers: unknown, baseDir: string): Found[] {
  if (!isRecord(servers)) return [];
  const marked = Object.fromEntries(
    Object.entries(servers).map(([name, raw]) => [
      name,
      isRecord(raw) && typeof raw.url === "string" && raw.httpUrl === undefined
        ? { ...raw, type: "sse" }
        : raw,
    ]),
  );
  return standardServers(marked, baseDir);
}

function vscodeServers(servers: unknown, baseDir: string): Found[] {
  return standardServers(servers, baseDir).map((found) =>
    typeof found.entry !== "string" && JSON.stringify(found.entry.transport).includes("${input:")
      ? { name: found.name, entry: "uses VS Code input variables, which mu cannot prompt for" }
      : found,
  );
}

interface SourceFile {
  file: string;
  source: McpSource;
  scope: McpScope;
  read: (text: string) => Found[];
}

function foreignFiles(home: string, projectDir: string | undefined): SourceFile[] {
  const files: SourceFile[] = [];
  const json = (text: string) => JSON.parse(text) as Raw;
  const project = (rel: string) => (projectDir ? join(projectDir, rel) : undefined);
  const add = (
    file: string | undefined,
    source: McpSource,
    scope: McpScope,
    read: SourceFile["read"],
  ) => {
    if (file) files.push({ file, source, scope, read });
  };
  const claudeFile = join(home, ".claude.json");
  add(project(".mcp.json"), "claude", "project", (t) =>
    standardServers(json(t).mcpServers, projectDir as string),
  );
  add(claudeFile, "claude", "user", (t) => {
    const data = json(t);
    const local = projectDir && isRecord(data.projects) ? data.projects[projectDir] : undefined;
    return [
      ...standardServers(isRecord(local) ? local.mcpServers : undefined, projectDir ?? home),
      ...standardServers(data.mcpServers, home),
    ];
  });
  add(project(join(".codex", "config.toml")), "codex", "project", (t) =>
    codexServers((Bun.TOML.parse(t) as Raw).mcp_servers, projectDir as string),
  );
  add(join(home, ".codex", "config.toml"), "codex", "user", (t) =>
    codexServers((Bun.TOML.parse(t) as Raw).mcp_servers, home),
  );
  add(project(join(".cursor", "mcp.json")), "cursor", "project", (t) =>
    standardServers(json(t).mcpServers, projectDir as string),
  );
  add(join(home, ".cursor", "mcp.json"), "cursor", "user", (t) =>
    standardServers(json(t).mcpServers, home),
  );
  for (const name of [
    "opencode.json",
    "opencode.jsonc",
    join(".opencode", "opencode.json"),
    join(".opencode", "opencode.jsonc"),
  ]) {
    add(project(name), "opencode", "project", (t) => opencodeServers((parseJsonc(t) as Raw).mcp));
  }
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    add(join(home, ".config", "opencode", name), "opencode", "user", (t) =>
      opencodeServers((parseJsonc(t) as Raw).mcp),
    );
  }
  add(project(join(".gemini", "settings.json")), "gemini", "project", (t) =>
    geminiServers((parseJsonc(t) as Raw).mcpServers, projectDir as string),
  );
  add(join(home, ".gemini", "settings.json"), "gemini", "user", (t) =>
    geminiServers((parseJsonc(t) as Raw).mcpServers, home),
  );
  add(project(join(".vscode", "mcp.json")), "vscode", "project", (t) =>
    vscodeServers((parseJsonc(t) as Raw).servers, projectDir as string),
  );
  return files;
}

export function transportFingerprint(transport: McpTransport): string {
  const identity =
    transport.type === "stdio"
      ? {
          type: "stdio",
          command: transport.command,
          args: transport.args ?? [],
          cwd: transport.cwd ?? "",
        }
      : { type: transport.type, url: transport.url };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
}

function isOverride(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    Object.keys(raw).length > 0 &&
    Object.keys(raw).every((key) => (OVERRIDE_KEYS as readonly string[]).includes(key))
  );
}

export async function loadMcpConfig(options: LoadMcpConfigOptions = {}): Promise<McpConfigReport> {
  const home = options.home ?? homedir();
  const userFile = options.userFile ?? join(home, ".mu", "config.json");
  const errors: McpConfigReport["errors"] = [];
  const servers: McpServerSpec[] = [];
  const shadowed: McpServerSpec[] = [];
  const overrides = new Map<string, Raw>();

  // mu's own files: user first, project entries replace same-named user entries.
  const native = new Map<string, McpServerSpec>();
  const muFiles: [string, McpScope][] = [[userFile, "user"]];
  if (options.projectDir) muFiles.push([join(options.projectDir, ".mu", "config.json"), "project"]);
  for (const [file, scope] of muFiles) {
    let text: string | undefined;
    try {
      text = await readText(file);
    } catch (error) {
      errors.push({ file, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (text === undefined) continue;
    let parsed: Raw;
    try {
      parsed = JSON.parse(text) as Raw;
    } catch (error) {
      errors.push({ file, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (parsed.mcpServers === undefined) continue;
    if (!isRecord(parsed.mcpServers)) {
      errors.push({ file, message: "mcpServers must be an object" });
      continue;
    }
    const invalid: string[] = [];
    for (const [name, raw] of Object.entries(parsed.mcpServers)) {
      if (isOverride(raw)) {
        overrides.set(name, { ...(overrides.get(name) ?? {}), ...(raw as Raw) });
        continue;
      }
      const [found] = standardServers({ [name]: raw }, dirname(file));
      if (!found || typeof found.entry === "string") {
        invalid.push(name);
        continue;
      }
      native.set(name, { name, source: "mu", scope, file, ...found.entry });
    }
    if (invalid.length > 0) {
      errors.push({
        file,
        message: `invalid MCP server config${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`,
      });
    }
  }

  const names = new Set<string>();
  const fingerprints = new Set<string>();
  const accept = (spec: McpServerSpec) => {
    const fingerprint = transportFingerprint(spec.transport);
    if (names.has(spec.name) || fingerprints.has(fingerprint)) {
      shadowed.push(spec);
      return;
    }
    names.add(spec.name);
    fingerprints.add(fingerprint);
    servers.push(spec);
  };
  for (const spec of native.values()) accept(spec);

  if (options.foreign !== false) {
    for (const source of foreignFiles(home, options.projectDir)) {
      let text: string | undefined;
      try {
        text = await readText(source.file);
      } catch {
        continue;
      }
      if (text === undefined) continue;
      let found: Found[];
      try {
        found = source.read(text);
      } catch (error) {
        errors.push({
          file: source.file,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      for (const { name, entry } of found) {
        if (typeof entry === "string") {
          errors.push({ file: source.file, message: `server "${name}": ${entry}` });
          continue;
        }
        accept({ name, source: source.source, scope: source.scope, file: source.file, ...entry });
      }
    }
  }

  for (const spec of servers) {
    const override = overrides.get(spec.name);
    if (!override) continue;
    const patch = common({ ...pick(spec), ...override });
    for (const key of OVERRIDE_KEYS) {
      if (override[key] !== undefined) Object.assign(spec, { [key]: patch[key] });
    }
  }
  return { servers, shadowed, errors };
}

function pick(spec: McpServerSpec): Raw {
  return Object.fromEntries(OVERRIDE_KEYS.map((key) => [key, spec[key]]));
}

// ${NAME}, ${env:NAME} and ${NAME:-default}; Cursor/VS Code workspace variables too.
export function expandVariables(
  value: string,
  env: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const expanded = value.replace(
    /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => {
      if (extra[name] !== undefined) return extra[name] as string;
      const found = env[name];
      if (found !== undefined && found !== "") return found;
      if (fallback !== undefined) return fallback;
      missing.push(name);
      return "";
    },
  );
  return { value: expanded, missing };
}

export function expandTransport(
  transport: McpTransport,
  env: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): { transport: McpTransport; missing: string[] } {
  const missing = new Set<string>();
  const x = (value: string) => {
    const result = expandVariables(value, env, extra);
    for (const name of result.missing) missing.add(name);
    return result.value;
  };
  const map = (record: Record<string, string> | undefined) =>
    record ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, x(v)])) : undefined;
  if (transport.type === "stdio") {
    const envVars = map(transport.env);
    return {
      transport: {
        type: "stdio",
        command: x(transport.command),
        ...(transport.args ? { args: transport.args.map(x) } : {}),
        ...(envVars ? { env: envVars } : {}),
        ...(transport.cwd ? { cwd: x(transport.cwd) } : {}),
      },
      missing: [...missing],
    };
  }
  const headers = map(transport.headers);
  return {
    transport: { type: transport.type, url: x(transport.url), ...(headers ? { headers } : {}) },
    missing: [...missing],
  };
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
    await chmod(file, 0o600).catch(() => {});
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readJsonObject(file: string): Promise<Raw> {
  const text = await readText(file);
  if (text === undefined) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

// Approval is keyed by project and server name, and tied to the command or URL it approved.
export interface McpApprovals {
  isApproved(projectDir: string, spec: McpServerSpec): boolean;
  approve(projectDir: string, spec: McpServerSpec): Promise<void>;
}

export async function loadMcpApprovals(file: string): Promise<McpApprovals> {
  let data: Raw = {};
  try {
    data = await readJsonObject(file);
  } catch {
    data = {};
  }
  const projects = (isRecord(data.projects) ? data.projects : {}) as Record<string, Raw>;
  return {
    isApproved: (projectDir, spec) =>
      projects[projectDir]?.[spec.name] === transportFingerprint(spec.transport),
    approve: async (projectDir, spec) => {
      projects[projectDir] = {
        ...(projects[projectDir] ?? {}),
        [spec.name]: transportFingerprint(spec.transport),
      };
      await writePrivateJson(file, { ...data, projects });
    },
  };
}

// Writes `mcpServers.<name>` fields into the user config, keeping everything else.
export async function updateUserServerEntry(file: string, name: string, patch: Raw): Promise<void> {
  const config = await readJsonObject(file);
  const servers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  servers[name] = { ...(isRecord(servers[name]) ? (servers[name] as Raw) : {}), ...patch };
  await writePrivateJson(file, { ...config, mcpServers: servers });
}
