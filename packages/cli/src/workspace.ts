import { basename } from "node:path";
import type { WorkspaceInfo } from "@mu/protocol";

// The session header is where a stored session records what it ran against.
// Reading the workspace back from it rather than from process state is what
// makes a resumed session report the right project instead of the current one.
export function workspaceFromEnvironment(
  environment: Record<string, string>,
  fallbackRoot: string,
): WorkspaceInfo {
  const root = environment.directory ?? fallbackRoot;
  return {
    name: basename(root) || root,
    root,
    ...(environment.branch ? { branch: environment.branch } : {}),
  };
}
