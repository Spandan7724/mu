import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentMessage, CustomMessage, Extension } from "mu";

// The folders a session's file tools reach besides the one mu started in (D92):
// `--add-dir` folders for the process, `/add-dir` folders recorded in the session
// transcript, and skill folders. Only the user adds folders; no tool can.
export const FOLDERS_CONTEXT_TYPE = "folders";

export interface FolderSession {
  id: string;
  messages: () => AgentMessage[];
}

export interface SessionFoldersOptions {
  // Relative /add-dir paths resolve against it.
  cwd: string;
  // The folder the file tools are rooted at (the browser's workspace may differ from cwd).
  startFolder?: string;
  // From --add-dir, already resolved.
  flagged?: string[];
  skillFolders?: () => readonly string[];
  // The agent's current session; folders added with /add-dir belong to it.
  session: () => FolderSession;
  home?: string;
}

export interface SessionFolders {
  // Every folder besides the start folder, for the file tools.
  reach(): string[];
  extension: Extension;
}

function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

// A directory the user named, resolved to its real path.
export function resolveFolder(input: string, cwd: string, home = homedir()): string {
  const expanded =
    input === "~" ? home : input.startsWith(`~/`) ? resolve(home, input.slice(2)) : input;
  const absolute = resolve(cwd, expanded);
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(absolute);
  } catch {
    throw new Error(`${absolute} does not exist`);
  }
  if (!info.isDirectory()) throw new Error(`${absolute} is not a directory`);
  return realpathSync.native(absolute);
}

function recordedFolders(messages: AgentMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "custom" || message.customType !== FOLDERS_CONTEXT_TYPE) continue;
    const added = (message.details as { added?: unknown } | undefined)?.added;
    return Array.isArray(added) ? added.filter((item) => typeof item === "string") : [];
  }
  return [];
}

function snapshotText(message: AgentMessage | undefined): string | undefined {
  if (message?.role !== "custom") return undefined;
  const block = message.content[0];
  return block?.type === "text" ? block.text : "";
}

function latestSnapshot(messages: AgentMessage[]): CustomMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "custom" && message.customType === FOLDERS_CONTEXT_TYPE) return message;
  }
  return undefined;
}

function folderListing(folders: string[]): string {
  if (folders.length === 0)
    return "The folders added earlier are no longer available; only the workspace and skill folders remain.";
  return [
    "Besides the workspace, the user gave you these folders for this session. Your file tools reach them; use absolute paths:",
    ...folders.map((folder) => `- ${folder}`),
  ].join("\n");
}

export function sessionFolders(options: SessionFoldersOptions): SessionFolders {
  const flagged = options.flagged ?? [];
  const start = options.startFolder ?? options.cwd;
  let current: { sessionId: string; added: string[] } | undefined;
  // Read from the transcript when the session changes (new, resume, fork), so a
  // folder stays with the session it was added in.
  const added = (): string[] => {
    const session = options.session();
    if (current?.sessionId !== session.id)
      current = { sessionId: session.id, added: recordedFolders(session.messages()) };
    return current.added;
  };
  const userFolders = () => [...new Set([...flagged, ...added()])];
  const reach = () => [...userFolders(), ...(options.skillFolders?.() ?? [])];

  const extension: Extension = {
    name: "folders",
    activate: (api) => {
      api.registerContextProvider((messages) => {
        const folders = userFolders();
        const latest = latestSnapshot(messages);
        if (!latest && folders.length === 0) return [];
        const text = folderListing(folders);
        const recorded = recordedFolders(messages);
        const session = added();
        if (
          snapshotText(latest) === text &&
          recorded.length === session.length &&
          recorded.every((folder, index) => folder === session[index])
        )
          return [];
        const message: CustomMessage = {
          role: "custom",
          customType: FOLDERS_CONTEXT_TYPE,
          content: [{ type: "text", text }],
          display: false,
          retention: { key: FOLDERS_CONTEXT_TYPE },
          details: { added: [...session] },
          timestamp: Date.now(),
        };
        return [message];
      });

      api.registerCommand({
        name: "add-dir",
        description: "Let the agent's file tools reach another folder for this session",
        run: ({ args }) => {
          const requested = args.trim();
          if (!requested) {
            const lines = [`Folders the file tools reach:`, `  ${start}  (start folder)`];
            for (const folder of flagged) lines.push(`  ${folder}  (--add-dir)`);
            for (const folder of added())
              if (!flagged.includes(folder)) lines.push(`  ${folder}  (/add-dir, this session)`);
            const skills = options.skillFolders?.() ?? [];
            if (skills.length > 0) lines.push(`  ${skills.length} skill folders (see /skills)`);
            return { handled: true, message: lines.join("\n") };
          }
          let folder: string;
          try {
            folder = resolveFolder(requested, options.cwd, options.home);
          } catch (error) {
            return {
              handled: true,
              message: `/add-dir: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          const covering = [start, ...userFolders()].find((existing) => inside(existing, folder));
          if (covering)
            return {
              handled: true,
              message:
                covering === folder
                  ? `${folder} is already reachable.`
                  : `${folder} is already reachable through ${covering}.`,
            };
          added().push(folder);
          return {
            handled: true,
            message: `Added ${folder} for this session. The agent is told from its next message.`,
          };
        },
      });
    },
  };
  return { reach, extension };
}
