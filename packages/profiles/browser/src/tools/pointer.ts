import type { ToolPermissionDetails, ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import type { BrowserPointerAction } from "../contracts/actions.ts";
import { COMMITMENT_RISKS, TAKEOVER_RISKS } from "../contracts/observation.ts";
import { actPattern } from "../policy/scopes.ts";
import type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
import { toolErrorText } from "./errors.ts";
import { observationFacts, observationHeadline, observationText, outcomeText } from "./render.ts";

export const BROWSER_POINTER_TOOL = "browser_pointer";

const coordinate = z.number().int().nonnegative().max(20_000);
const schema = z
  .object({
    action: z.enum(["click", "double-click", "move", "drag", "scroll"]),
    x: coordinate,
    y: coordinate,
    toX: coordinate.optional(),
    toY: coordinate.optional(),
    deltaX: z.number().int().min(-20_000).max(20_000).optional(),
    deltaY: z.number().int().min(-20_000).max(20_000).optional(),
    screenshotRevision: z.number().int().nonnegative(),
    screenshotEvidenceId: z.string().min(1).max(100),
  })
  .superRefine((args, ctx) => {
    if (args.action === "drag" && (args.toX === undefined || args.toY === undefined)) {
      ctx.addIssue({ code: "custom", path: ["toX"], message: "drag needs toX and toY" });
    }
    if (args.action === "scroll" && (args.deltaX === undefined || args.deltaY === undefined)) {
      ctx.addIssue({ code: "custom", path: ["deltaY"], message: "scroll needs deltaX and deltaY" });
    }
  });

type Args = z.infer<typeof schema>;

function request(args: Args): BrowserPointerAction {
  if (args.action === "drag") {
    return { kind: "drag", x: args.x, y: args.y, toX: args.toX as number, toY: args.toY as number };
  }
  if (args.action === "scroll") {
    return {
      kind: "scroll",
      x: args.x,
      y: args.y,
      deltaX: args.deltaX as number,
      deltaY: args.deltaY as number,
    };
  }
  return { kind: args.action, x: args.x, y: args.y };
}

export function browserPointerTool(context: BrowserToolContext) {
  const { session } = context;
  const recordFor = (args: Args) => {
    const record = session.record();
    if (
      record === undefined ||
      record.revision !== args.screenshotRevision ||
      record.evidenceId !== args.screenshotEvidenceId ||
      record.screenshotScope !== "viewport" ||
      record.observation.screenshot === undefined
    )
      return undefined;
    return record;
  };
  return tool({
    name: BROWSER_POINTER_TOOL,
    description:
      "Fallback for a visible canvas or control that browser_observe cannot represent semantically. First request a viewport screenshot, then use its exact revision and evidence ID. Prefer semantic refs whenever available. Known commitments and credential regions remain blocked; this tool never handles CAPTCHA or secret entry.",
    inputSchema: schema,
    isConcurrencySafe: () => false,
    changesState: true,
    permissionScope: () => "browser:interact",
    permissionPattern: (args) => actPattern(recordFor(args)?.observation.origin),
    permissionDetails: (args): ToolPermissionDetails => ({
      description: `${args.action} visually at ${args.x},${args.y}`,
      preview: {
        kind: "text",
        lines: [
          `origin: ${recordFor(args)?.observation.origin ?? "unknown"}`,
          `page: ${recordFor(args)?.observation.title ?? "screenshot is stale or unavailable"}`,
          `coordinate: ${args.x},${args.y} from ${args.screenshotEvidenceId}`,
        ],
      },
    }),
    execute: async (args, { signal }): Promise<ToolResult> => {
      try {
        const record = recordFor(args);
        if (record === undefined) {
          return {
            content: [
              {
                type: "text",
                text: 'That screenshot is stale or unavailable. Call browser_observe with screenshot "viewport" and use the returned revision and evidence ID.',
              },
            ],
            isError: true,
          };
        }
        const { width, height } = record.observation.viewport;
        const points = [
          { x: args.x, y: args.y },
          ...(args.action === "drag" ? [{ x: args.toX as number, y: args.toY as number }] : []),
        ];
        if (points.some((point) => point.x >= width || point.y >= height)) {
          return {
            content: [{ type: "text", text: `Coordinates must stay inside ${width}×${height}.` }],
            isError: true,
          };
        }
        const hit = record.sourceObservation.elements.filter((element) => {
          const box = element.box;
          return (
            box !== undefined &&
            points.some(
              (point) =>
                point.x >= box.x &&
                point.y >= box.y &&
                point.x < box.x + box.width &&
                point.y < box.y + box.height,
            )
          );
        });
        const risks = new Set(hit.flatMap((element) => element.risk ?? []));
        if ([...risks].some((risk) => TAKEOVER_RISKS.includes(risk))) {
          return {
            content: [
              {
                type: "text",
                text: "That visual region is authentication-, credential-, or CAPTCHA-related. Use browser_takeover; pointer interaction is forbidden there.",
              },
            ],
            isError: true,
          };
        }
        if (
          args.action !== "move" &&
          args.action !== "scroll" &&
          [...risks].some((risk) => COMMITMENT_RISKS.includes(risk))
        ) {
          return {
            content: [
              {
                type: "text",
                text: "That visual region contains a known commitment. Use its semantic reference with browser_submit; pointer interaction cannot bypass commitment routing.",
              },
            ],
            isError: true,
          };
        }

        const outcome = await session.use(
          (driver) => driver.pointer(request(args), signal),
          signal,
        );
        const after = await session.observe({ tabId: record.tabId }, signal);
        const pattern = actPattern(record.observation.origin, hit[0]);
        session.note({
          tool: BROWSER_POINTER_TOOL,
          action: args.action,
          tabId: after.tabId,
          url: after.observation.url,
          ...(after.observation.origin === undefined ? {} : { origin: after.observation.origin }),
          revision: after.revision,
          outcome: outcome.status,
          scope: "browser:interact",
          pattern,
        });
        const details: BrowserToolDetails = {
          kind: "action",
          tool: BROWSER_POINTER_TOOL,
          action: args.action,
          status: outcome.status,
          tabId: after.tabId,
          url: after.observation.url,
          navigated: outcome.navigation !== undefined,
          scope: "browser:interact",
          pattern,
        };
        return {
          content: [
            {
              type: "text",
              text: [
                outcomeText(outcome),
                observationHeadline(after),
                ...observationFacts(after),
                observationText(after),
              ].join("\n"),
            },
          ],
          details,
          ...(outcome.ok ? {} : { isError: true }),
        };
      } catch (error) {
        return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
      }
    },
  });
}
