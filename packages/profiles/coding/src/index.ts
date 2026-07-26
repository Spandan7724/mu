import { resolve } from "node:path";
import { type AgentMessage, type AnyTool, ProcessManager, type Profile } from "@mu/core";
import { ShadowCheckpointProvider } from "./checkpoint.ts";
import { codingEnvironment, contextMessages, environmentMessage } from "./context.ts";
import { CODING_PERMISSION_DEFAULTS, layerPermissions, loadProjectConfig } from "./permissions.ts";
import { codingPrompt } from "./prompts.ts";
import { FileState } from "./state.ts";
import { bashTool } from "./tools/bash.ts";
import { editTool, lsTool, readTool, writeTool } from "./tools/files.ts";
import { globTool, grepTool } from "./tools/search.ts";
import { shellSpawner, taskTools } from "./tools/tasks.ts";
import { TodoStore, todoTool } from "./tools/todo.ts";

export interface CodingProfileOptions {
  // Directory the session operates in. Defaults to the process's directory.
  root?: string;
  // Injected in tests so no real process is ever spawned.
  spawn?: Parameters<typeof bashTool>[0]["spawn"];
  spawner?: ConstructorParameters<typeof ProcessManager>[0];
  processEvents?: ConstructorParameters<typeof ProcessManager>[1];
}

export interface CodingProfile extends Profile {
  fileState: FileState;
  todos: TodoStore;
  processes: ProcessManager;
}

export async function codingProfile(options: CodingProfileOptions = {}): Promise<CodingProfile> {
  const root = resolve(options.root ?? process.cwd());
  const fileState = new FileState();
  const todos = new TodoStore();
  const deps = { root, state: fileState };
  const processes = new ProcessManager(
    options.spawner ?? shellSpawner(root),
    options.processEvents ?? {},
  );

  const toolset: AnyTool[] = [
    readTool(deps),
    writeTool(deps),
    editTool(deps),
    lsTool(deps),
    globTool(deps),
    grepTool(deps),
    bashTool({ root, processes, ...(options.spawn ? { spawn: options.spawn } : {}) }),
    todoTool(todos),
    ...taskTools(processes),
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
    checkpointProvider: new ShadowCheckpointProvider({ root }),
    fileState,
    todos,
    processes,
  };
}

export type { GitRunner, ShadowCheckpointOptions } from "./checkpoint.ts";
export { ShadowCheckpointProvider } from "./checkpoint.ts";
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
export { shellSpawner, taskTools } from "./tools/tasks.ts";
export type { TodoItem } from "./tools/todo.ts";
export { renderTodos, TodoStore, todoTool } from "./tools/todo.ts";
export { MAX_OUTPUT_CHARS, truncateOutput, withNotice } from "./truncate.ts";
