import type { AnyTool } from "@mu/core";
import { z } from "zod";

export const STRUCTURED_OUTPUT_TOOL = "structured_output";

export function structuredOutputTool<Schema extends z.ZodType>(
  schema: Schema,
  capture: (value: z.infer<Schema>) => void,
): AnyTool {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      "Report the final answer. Call this exactly once, when you have the complete result. Do not call any other tool afterwards.",
    inputSchema: jsonSchema,
    execute: async (_id, args) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        return {
          content: [
            {
              type: "text",
              text: `Output did not match the required schema: ${issues}. Call ${STRUCTURED_OUTPUT_TOOL} again with corrected values.`,
            },
          ],
          isError: true,
        };
      }
      capture(parsed.data);
      return { content: [{ type: "text", text: "Final answer recorded." }], terminate: true };
    },
  };
}

export function structuredOutputPrompt(): string {
  return `When you have the final answer, call the ${STRUCTURED_OUTPUT_TOOL} tool with it. That call ends the task.`;
}
