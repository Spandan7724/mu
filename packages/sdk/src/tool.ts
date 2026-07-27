import type { AnyTool, Tool, ToolResult } from "@mu/core";
import { errorResult } from "@mu/core";
import { z } from "zod";

export type { ToolResult };

export interface ToolDefinition<Schema extends z.ZodType> {
  name: string;
  description: string;
  inputSchema: Schema;
  isConcurrencySafe?: (args: z.infer<Schema>) => boolean;
  executionMode?: "sequential";
  changesState?: boolean | ((args: z.infer<Schema>) => boolean);
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

  return {
    name: definition.name,
    description: definition.description,
    inputSchema: jsonSchema,
    ...(definition.isConcurrencySafe ? { isConcurrencySafe: definition.isConcurrencySafe } : {}),
    ...(definition.executionMode ? { executionMode: definition.executionMode } : {}),
    ...(definition.changesState !== undefined ? { changesState: definition.changesState } : {}),
    execute: async (toolCallId, rawArgs, signal, onUpdate) => {
      const parsed = definition.inputSchema.safeParse(rawArgs);
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
