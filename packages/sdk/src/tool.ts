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
  permissionScope?: (args: z.infer<Schema>) => string;
  permissionPattern?: (args: z.infer<Schema>) => string;
  permissionDetails?: (
    args: z.infer<Schema>,
  ) => ToolPermissionDetails | undefined | Promise<ToolPermissionDetails | undefined>;
  execute: (
    args: z.infer<Schema>,
    ctx: { toolCallId: string; signal: AbortSignal; update: (text: string) => void },
  ) => Promise<ToolResult | string> | ToolResult | string;
}

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

  return {
    name: definition.name,
    description: definition.description,
    inputSchema: jsonSchema,
    ...(definition.isConcurrencySafe ? { isConcurrencySafe: definition.isConcurrencySafe } : {}),
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    ...(definition.changesState !== undefined ? { changesState: definition.changesState } : {}),
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
    execute: async (toolCallId, rawArgs, signal, onUpdate) => {
      const parsed = parseArgs(rawArgs);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return errorResult(`Invalid arguments for ${definition.name}: ${issues}`);
      }
      const update = (text: string) => onUpdate?.([{ type: "text", text }]);
      return normalize(await definition.execute(parsed.data, { toolCallId, signal, update }));
    },
  };
}

export function asAnyTool<Schema extends z.ZodType>(t: Tool<z.infer<Schema>>): AnyTool {
  return t as AnyTool;
}
