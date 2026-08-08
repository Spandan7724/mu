import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  AGENT_VIEW_PROTOCOL_VERSION,
  type ManagedSessionRecord,
  managedSessionRecordSchema,
  rosterSchema,
} from "./agent-view-state.ts";

export interface AgentViewPaths {
  root: string;
  roster: string;
  endpoint: string;
  supervisor: string;
  lock: string;
  sessions: string;
}

export function defaultMuHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MU_HOME) return env.MU_HOME;
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error("cannot locate the user home directory");
  return join(home, ".mu");
}

export function agentViewPaths(
  root = join(defaultMuHome(), "agents"),
  platform: NodeJS.Platform = process.platform,
): AgentViewPaths {
  const pipeKey = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return {
    root,
    roster: join(root, "roster.json"),
    endpoint:
      platform === "win32" ? `\\\\.\\pipe\\mu-agents-${pipeKey}` : join(root, "supervisor.sock"),
    supervisor: join(root, "supervisor.json"),
    lock: join(root, "supervisor.lock"),
    sessions: join(root, "sessions"),
  };
}

export function projectScope(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}

export function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export async function atomicPrivateWrite(path: string, value: string): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class AgentViewRosterStore {
  constructor(readonly paths = agentViewPaths()) {}

  async load(): Promise<ManagedSessionRecord[]> {
    let source: string;
    try {
      source = await readFile(this.paths.roster, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = rosterSchema.safeParse(JSON.parse(source) as unknown);
    if (!parsed.success) {
      throw new Error(
        `invalid agent-view roster: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    return parsed.data.records;
  }

  async save(records: readonly ManagedSessionRecord[]): Promise<void> {
    const validated = records.map((record) => managedSessionRecordSchema.parse(record));
    await atomicPrivateWrite(
      this.paths.roster,
      `${JSON.stringify({ version: AGENT_VIEW_PROTOCOL_VERSION, records: validated }, null, 2)}\n`,
    );
  }

  async initialize(): Promise<void> {
    await privateDirectory(this.paths.root);
    await privateDirectory(this.paths.sessions);
  }
}

export const ownershipRecordSchema = z
  .object({
    version: z.literal(AGENT_VIEW_PROTOCOL_VERSION),
    sessionId: z.string().min(1).max(512),
    token: z.string().uuid(),
    supervisorPid: z.number().int().positive(),
    workerPid: z.number().int().positive().optional(),
    endpoint: z.string().min(1).max(8_192),
    createdAt: z.number().int().nonnegative(),
  })
  .passthrough();

export interface SessionOwnership {
  version: number;
  sessionId: string;
  token: string;
  supervisorPid: number;
  workerPid?: number;
  endpoint: string;
  createdAt: number;
}

export function ownershipPath(paths: AgentViewPaths, sessionId: string): string {
  return join(paths.sessions, encodeSessionId(sessionId), "owner.json");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readSessionOwnership(
  paths: AgentViewPaths,
  sessionId: string,
): Promise<SessionOwnership | undefined> {
  try {
    const source = await readFile(ownershipPath(paths, sessionId), "utf8");
    const parsed = ownershipRecordSchema.safeParse(JSON.parse(source) as unknown);
    if (!parsed.success || parsed.data.sessionId !== sessionId) {
      throw new Error(`invalid ownership record for session ${sessionId}`);
    }
    return parsed.data as SessionOwnership;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function acquireSessionOwnership(
  paths: AgentViewPaths,
  sessionId: string,
  options: { endpoint?: string; supervisorPid?: number; recoverStale?: boolean } = {},
): Promise<SessionOwnership> {
  const path = ownershipPath(paths, sessionId);
  await privateDirectory(dirname(path));
  const existing = await readSessionOwnership(paths, sessionId);
  if (existing) {
    if (isProcessAlive(existing.supervisorPid)) {
      throw new Error(`session ${sessionId} is already owned by runtime ${existing.supervisorPid}`);
    }
    if (!options.recoverStale) {
      throw new Error(
        `session ${sessionId} has a stale ownership claim; run agent-view recovery before resuming it`,
      );
    }
    await unlink(path);
  }

  const record: SessionOwnership = {
    version: AGENT_VIEW_PROTOCOL_VERSION,
    sessionId,
    token: randomUUID(),
    supervisorPid: options.supervisorPid ?? process.pid,
    endpoint: options.endpoint ?? paths.endpoint,
    createdAt: Date.now(),
  };
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
  return record;
}

export async function updateSessionOwnershipWorker(
  paths: AgentViewPaths,
  ownership: SessionOwnership,
  workerPid: number,
): Promise<SessionOwnership> {
  const current = await readSessionOwnership(paths, ownership.sessionId);
  if (!current || current.token !== ownership.token) {
    throw new Error(`ownership changed for session ${ownership.sessionId}`);
  }
  const next = { ...current, workerPid };
  await atomicPrivateWrite(ownershipPath(paths, ownership.sessionId), `${JSON.stringify(next)}\n`);
  return next;
}

export async function releaseSessionOwnership(
  paths: AgentViewPaths,
  ownership: Pick<SessionOwnership, "sessionId" | "token">,
): Promise<boolean> {
  const current = await readSessionOwnership(paths, ownership.sessionId);
  if (!current || current.token !== ownership.token) return false;
  await unlink(ownershipPath(paths, ownership.sessionId));
  return true;
}
