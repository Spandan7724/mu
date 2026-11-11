import {
  type AgentEvent,
  type AnyTool,
  type ExtensionHost,
  evaluateTargets,
  type LoopConfig,
  type PermissionReply,
  type PermissionRequest,
  type PermissionRule,
  type PermissionTarget,
  permissionOutcome,
} from "@mu/core";

type BeforeToolCall = NonNullable<LoopConfig["beforeToolCall"]>;
export type ToolCallGate = (
  info: Parameters<BeforeToolCall>[0],
) => Promise<Awaited<ReturnType<BeforeToolCall>>>;

export interface PermissionGateOptions {
  tools: AnyTool[];
  // Read on every call: rules can change while a run is active.
  rules: () => PermissionRule[];
  host?: ExtensionHost | undefined;
  onPermission?:
    | ((request: PermissionRequest) => PermissionReply | Promise<PermissionReply>)
    | undefined;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  // Tool names that are internal plumbing and never gated.
  exempt?: readonly string[];
  // Settles before any call is judged (the before-turn checkpoint).
  ready?: Promise<unknown>;
}

// Decides whether one tool call may run: extension hooks first (veto or rewrite),
// then the permission rules over the call's targets, then the user when a rule
// says ask. An unanswered ask is a denial, so an unattended process never hangs.
export function createPermissionGate(options: PermissionGateOptions): ToolCallGate {
  const { tools, host, signal, emit } = options;
  return async (info) => {
    if (options.exempt?.includes(info.toolCall.name)) return undefined;
    await options.ready;

    let args = info.args;
    if (host) {
      const directive = await host.runToolCallHooks({
        toolName: info.toolCall.name,
        toolCallId: info.toolCall.id,
        args,
      });
      if (directive?.block) {
        return { block: true, reason: directive.reason ?? "Blocked by an extension" };
      }
      if (directive?.args) args = directive.args;
    }

    const selectedTool = tools.find((tool) => tool.name === info.toolCall.name);
    let permission = info.toolCall.name;
    try {
      permission = selectedTool?.permissionScope?.(args) ?? permission;
    } catch {
      // A broken profile classifier must fall back to the concrete tool.
    }
    let pattern = JSON.stringify(args);
    try {
      pattern = selectedTool?.permissionPattern?.(args) ?? pattern;
    } catch {
      // A broken profile projection must not bypass the generic permission rules.
    }
    let targets: PermissionTarget[] = [{ permission, pattern }];
    try {
      const projected = selectedTool?.permissionTargets?.(args);
      if (projected && projected.length > 0) targets = projected;
    } catch {
      // Unprojectable arguments are judged by the call's single scope and pattern.
    }
    const { action, asked } = evaluateTargets(options.rules(), info.toolCall.name, targets);
    const rewritten = args === info.args ? undefined : { rewrittenArgs: args };
    if (action === "allow") {
      return rewritten;
    }
    if (action === "deny") {
      return { block: true, denied: true, reason: `Permission denied for ${info.toolCall.name}` };
    }
    const details = await Promise.resolve(selectedTool?.permissionDetails?.(args)).catch(
      () => undefined,
    );
    const request: PermissionRequest = {
      id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      toolCallId: info.toolCall.id,
      toolName: info.toolCall.name,
      permission,
      pattern,
      description: details?.description ?? `Run ${info.toolCall.name}`,
      ...(details?.preview ? { preview: details.preview } : {}),
      allowRules: asked.map((target) => ({
        permission: target.permission ?? info.toolCall.name,
        pattern: target.remember ?? target.pattern,
      })),
    };
    emit({ type: "permission_asked", request });
    // Default DENY: never hang an unattended process on an unanswered ask.
    let decision: { outcome: "allow" | "deny"; message?: string } = { outcome: "deny" };
    if (options.onPermission && !signal.aborted) {
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<"deny">((resolve) => {
        onAbort = () => resolve("deny");
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        decision = permissionOutcome(await Promise.race([options.onPermission(request), aborted]));
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }
    emit({ type: "permission_resolved", requestId: request.id, outcome: decision.outcome });
    if (decision.outcome === "allow") {
      return rewritten;
    }
    return {
      block: true,
      denied: true,
      reason: decision.message
        ? `Permission denied for ${info.toolCall.name}. The user said: ${decision.message}`
        : `Permission denied for ${info.toolCall.name}`,
    };
  };
}
