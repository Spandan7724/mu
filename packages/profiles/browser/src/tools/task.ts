import { tool } from "mu";
import { z } from "zod";
import { observePattern } from "../policy/scopes.ts";
import type { BrowserToolContext } from "./context.ts";
import type { BrowserTaskState } from "./task-ledger.ts";

export const BROWSER_TASK_TOOL = "browser_task";

const criterion = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    description: z.string().min(1).max(300),
    kind: z.enum(["fact", "ordered-list", "exhaustive", "action"]),
    requiredCount: z.number().int().positive().max(1_000).optional(),
  })
  .refine((value) => value.kind === "ordered-list" || value.requiredCount === undefined, {
    message: "requiredCount is only valid for an ordered-list criterion",
  });

const schema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("plan"),
    criteria: z.array(criterion).min(1).max(20),
    steps: z.array(z.string().min(1).max(300)).min(1).max(30),
  }),
  z.object({
    operation: z.literal("evidence"),
    criterionId: z.string().min(1).max(40),
    evidenceId: z.string().min(1).max(100),
    observedItems: z.number().int().nonnegative().max(10_000).optional(),
  }),
  z.object({ operation: z.literal("status") }),
]);

function renderState(state: BrowserTaskState): string[] {
  return [
    `Task status: ${state.status}`,
    ...state.criteria.map(
      (entry) =>
        `- [${entry.satisfied ? "x" : " "}] ${entry.id} (${entry.kind}): ${entry.description}${
          entry.evidence.length === 0
            ? ""
            : ` · evidence ${entry.evidence.map((item) => item.evidenceId).join(", ")}`
        }`,
    ),
    "Steps:",
    ...state.steps.map((step, index) => `${index + 1}. ${step}`),
  ];
}

export function browserTaskTool(context: BrowserToolContext) {
  const { session } = context;
  return tool({
    name: BROWSER_TASK_TOOL,
    description:
      "Plan and verify a multi-step browser task. Criteria are append-only and become satisfied only from session-minted browser evidence; the model cannot mark itself complete. Use ordered-list for ranked/top-N results, exhaustive when every result must be covered, fact for page-grounded claims, and action for a completed reversible browser action. Check status before answering.",
    inputSchema: schema,
    isConcurrencySafe: () => false,
    changesState: false,
    permissionScope: () => "browser:observe",
    permissionPattern: () => observePattern(session.record()?.observation.origin),
    execute: async (args) => {
      try {
        const state = (() => {
          switch (args.operation) {
            case "plan": {
              const ids = new Set(args.criteria.map((entry) => entry.id));
              if (ids.size !== args.criteria.length)
                throw new TypeError("criterion ids must be unique");
              return session.planTask(args.criteria, args.steps);
            }
            case "evidence":
              return session.attachTaskEvidence(
                args.criterionId,
                args.evidenceId,
                args.observedItems,
              );
            case "status":
              return session.task.state();
          }
        })();
        const evidence = session.task.evidence();
        return {
          content: [
            {
              type: "text" as const,
              text: [
                ...renderState(state),
                ...(evidence.length === 0
                  ? []
                  : [
                      "Recent session evidence:",
                      ...evidence.map(
                        (entry) =>
                          `- ${entry.id}: ${entry.kind}${entry.url === undefined ? "" : ` at ${entry.url}`}${
                            entry.order === undefined ? "" : ` · ${entry.order} order`
                          }${entry.outcome === undefined ? "" : ` · ${entry.outcome}`}`,
                      ),
                    ]),
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    },
  });
}
