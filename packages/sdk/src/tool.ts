import type { AnyTool, Tool, ToolPermissionDetails, ToolResult } from "@mu/core";
import { errorResult } from "@mu/core";
import { z } from "zod";

export type { ToolResult };

export interface ToolDefinition<Schema extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: Schema;
  // Normalizes raw provider arguments before validation, for input shapes models
  // emit that the schema deliberately does not advertise. Never rejects: anything
  // it does not recognize is passed through for the schema to judge.
  coerceInput?: (raw: unknown) => unknown;
  isConcurrencySafe?: (args: z.infer<Schema>) => boolean;
  executionMode?: "sequential";
  changesState?: boolean | ((args: z.infer<Schema>) => boolean);
  changedResources?: (args: z.infer<Schema>) => string[];
  permissionScope?: (args: z.infer<Schema>) => string;
  permissionPattern?: (args: z.infer<Schema>) => string;
  permissionDetails?: (
    args: z.infer<Schema>,
  ) => ToolPermissionDetails | undefined | Promise<ToolPermissionDetails | undefined>;
  canBackground?: (args: z.infer<Schema>) => boolean;
  execute: (
    args: z.infer<Schema>,
    ctx: {
      toolCallId: string;
      signal: AbortSignal;
      update: (text: string, details?: unknown) => void;
      // Fires when the user moves the running call to the background (canBackground).
      background: AbortSignal;
    },
  ) => Promise<ToolResult | string> | ToolResult | string;
}

const NEVER = new AbortController().signal;

function normalize(result: ToolResult | string): ToolResult {
  return typeof result === "string" ? { content: [{ type: "text", text: result }] } : result;
}

// Defines a tool from a Zod schema: JSON Schema for the wire is derived, and
// arguments are validated before execute ever sees them.
export function tool<Schema extends z.ZodType>(
  definition: ToolDefinition<Schema>,
): Tool<z.infer<Schema>> {
  const jsonSchema = z.toJSONSchema(definition.inputSchema, { io: "input" }) as Record<
    string,
    unknown
  >;

  const parseArgs = (rawArgs: unknown) => {
    let input = rawArgs;
    if (definition.coerceInput) {
      try {
        input = definition.coerceInput(rawArgs);
      } catch {
        input = rawArgs;
      }
    }
    return definition.inputSchema.safeParse(input);
  };
  const concurrencyCheck = definition.isConcurrencySafe;
  const stateChangeCheck = definition.changesState;
  const resourceCheck = definition.changedResources;
  const backgroundCheck = definition.canBackground;

  return {
    name: definition.name,
    description: definition.description,
    inputSchema: jsonSchema,
    ...(concurrencyCheck
      ? {
          isConcurrencySafe: (rawArgs: unknown) => {
            const parsed = parseArgs(rawArgs);
            if (!parsed.success) return false;
            try {
              return concurrencyCheck(parsed.data) === true;
            } catch {
              return false;
            }
          },
        }
      : {}),
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    ...(stateChangeCheck !== undefined
      ? {
          changesState:
            typeof stateChangeCheck === "function"
              ? (rawArgs: unknown) => {
                  const parsed = parseArgs(rawArgs);
                  if (!parsed.success) return true;
                  try {
                    return stateChangeCheck(parsed.data) === true;
                  } catch {
                    return true;
                  }
                }
              : stateChangeCheck,
        }
      : {}),
    ...(resourceCheck
      ? {
          changedResources: (rawArgs: unknown) => {
            const parsed = parseArgs(rawArgs);
            if (!parsed.success) throw new Error(`Invalid arguments for ${definition.name}`);
            return resourceCheck(parsed.data);
          },
        }
      : {}),
    ...(definition.permissionScope
      ? {
          permissionScope: (rawArgs) => {
            const parsed = parseArgs(rawArgs);
            return parsed.success
              ? (definition.permissionScope?.(parsed.data) ?? definition.name)
              : definition.name;
          },
        }
      : {}),
    ...(definition.permissionPattern
      ? {
          permissionPattern: (rawArgs) => {
            const parsed = parseArgs(rawArgs);
            return parsed.success
              ? (definition.permissionPattern?.(parsed.data) ?? JSON.stringify(rawArgs))
              : JSON.stringify(rawArgs);
          },
        }
      : {}),
    ...(definition.permissionDetails
      ? {
          permissionDetails: async (rawArgs) => {
            const parsed = parseArgs(rawArgs);
            return parsed.success ? definition.permissionDetails?.(parsed.data) : undefined;
          },
        }
      : {}),
    ...(backgroundCheck
      ? {
          canBackground: (rawArgs: unknown) => {
            const parsed = parseArgs(rawArgs);
            return parsed.success && backgroundCheck(parsed.data) === true;
          },
        }
      : {}),
    execute: async (toolCallId, rawArgs, signal, onUpdate, background) => {
      const parsed = parseArgs(rawArgs);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return errorResult(`Invalid arguments for ${definition.name}: ${issues}`);
      }
      const update = (text: string, details?: unknown) =>
        onUpdate?.(text.length > 0 ? [{ type: "text", text }] : [], details);
      return normalize(
        await definition.execute(parsed.data, {
          toolCallId,
          signal,
          update,
          background: background ?? NEVER,
        }),
      );
    },
  };
}

export function asAnyTool<Schema extends z.ZodType>(t: Tool<z.infer<Schema>>): AnyTool {
  return t as AnyTool;
}
