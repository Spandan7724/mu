import { resolve } from "node:path";
import type { AgentMessage, AnyTool, Profile } from "@mu/core";
import { codingEnvironment, contextMessages, environmentMessage } from "./context.ts";
import { CODING_PERMISSION_DEFAULTS, layerPermissions, loadProjectConfig } from "./permissions.ts";
import { codingPrompt } from "./prompts.ts";
import { FileState } from "./state.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool, lsTool, readTool, writeTool } from "./tools/files.ts";
import { globTool, grepTool } from "./tools/search.ts";
import { TodoStore, todoTool } from "./tools/todo.ts";

export interface CodingProfileOptions {
  // Directory the session operates in. Defaults to the process's directory.
  root?: string;
  // Injected in tests so no real process is ever spawned.
  spawn?: Parameters<typeof bashTool>[0]["spawn"];
}

export interface CodingProfile extends Profile {
  fileState: FileState;
  todos: TodoStore;
}

export async function codingProfile(options: CodingProfileOptions = {}): Promise<CodingProfile> {
  const root = resolve(options.root ?? process.cwd());
  const fileState = new FileState();
  const todos = new TodoStore();
  const deps = { root, state: fileState };

  const toolset: AnyTool[] = [
    readTool(deps),
    writeTool(deps),
    editTool(deps),
    lsTool(deps),
    globTool(deps),
    grepTool(deps),
    bashTool({ root, ...(options.spawn ? { spawn: options.spawn } : {}) }),
    todoTool(todos),
  ] as AnyTool[];

  const projectConfig = await loadProjectConfig(root);

  return {
    name: "coding",
    toolset,
    promptFor: codingPrompt,
    permissionDefaults: layerPermissions(CODING_PERMISSION_DEFAULTS, projectConfig.permissions),
    environment: () => codingEnvironment(root),
    contextMessages: async (): Promise<AgentMessage[]> => [
      environmentMessage(await codingEnvironment(root)),
      ...(await contextMessages(root)),
    ],
    // What compaction must not lose: which files this session touched.
    carryoverExtractor: () => ({
      readFiles: fileState.readFiles(),
      modifiedFiles: fileState.modifiedFiles(),
      todos: todos.all(),
    }),
    scope: () => root.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    fileState,
    todos,
  };
}

export {
  codingEnvironment,
  contextMessages,
  discoverContextFiles,
  environmentMessage,
} from "./context.ts";
export {
  CODING_PERMISSION_DEFAULTS,
  layerPermissions,
  loadProjectConfig,
  rememberAllow,
} from "./permissions.ts";
export { codingPrompt } from "./prompts.ts";
export { FileState } from "./state.ts";
export { bashTool } from "./tools/bash.ts";
export { editTool, lsTool, readTool, resolveInRoot, writeTool } from "./tools/files.ts";
export { globTool, globToRegExp, grepTool } from "./tools/search.ts";
export type { TodoItem } from "./tools/todo.ts";
export { renderTodos, TodoStore, todoTool } from "./tools/todo.ts";
export { MAX_OUTPUT_CHARS, truncateOutput, withNotice } from "./truncate.ts";
