import type { ToolPermissionDetails, ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import type { BrowserAction } from "../contracts/actions.ts";
import type { ApplicantFact } from "../contracts/applicant.ts";
import { BROWSER_LIMITS } from "../contracts/json.ts";
import {
  type BrowserElement,
  browserElementRefSchema,
  isCredentialElement,
} from "../contracts/observation.ts";
import { REDACTED } from "../contracts/secret.ts";
import { factValueText } from "../data/facts.ts";
import { decideActRequest } from "../policy/decide.ts";
import { actPattern, type BrowserScope, scopesForAction } from "../policy/scopes.ts";
import type { BrowserToolContext, BrowserToolDetails } from "./context.ts";
import { toolErrorText } from "./errors.ts";
import { KEY_NAMES, normalizeKey } from "./keys.ts";
import { runBrowserOperation, stage, stop } from "./operation.ts";
import { type DisclosureContext, disclosesPersonalData, prepareAction } from "./pipeline.ts";
import { observationFacts, observationHeadline, observationText, outcomeText } from "./render.ts";
import type { ObservationRecord } from "./session.ts";

export const BROWSER_ACT_TOOL = "browser_act";

const ACTIONS = [
  "click",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "press",
  "hover",
  "scroll",
  "drag",
] as const;

const text = z.string().max(BROWSER_LIMITS.maxElementTextChars);

const schema = z
  .object({
    action: z.enum(ACTIONS),
    target: browserElementRefSchema
      .optional()
      .describe(
        "A reference from the latest observation. Omit for page scrolling; provide only to scroll a specific nested container.",
      ),
    value: text.optional().describe("The text to enter, for fill and type."),
    values: z
      .array(text)
      .min(1)
      .max(BROWSER_LIMITS.maxOptionsPerElement)
      .optional()
      .describe("Option values to choose, for select."),
    key: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        `A key name, for press: ${KEY_NAMES.join(", ")}, a single character, or a combination such as Control+a.`,
      ),
    deltaX: z.number().int().optional(),
    deltaY: z.number().int().optional(),
    source: browserElementRefSchema.optional().describe("What to drag."),
    destination: browserElementRefSchema.optional().describe("Where to drop it."),
    factId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "The id of the authorized applicant fact this value comes from. Required for anything about the user that you did not just read off this page.",
      ),
  })
  .superRefine((args, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const needsTarget =
      args.action !== "press" && args.action !== "scroll" && args.action !== "drag";
    if (needsTarget && args.target === undefined) {
      issue("target", `${args.action} needs a target reference from the latest observation`);
    }
    switch (args.action) {
      case "fill":
        if (args.value === undefined && args.factId === undefined) {
          issue("value", "fill needs a value, or a factId naming the value to enter");
        }
        break;
      case "type":
        if (args.value === undefined) issue("value", "type needs the text to send");
        break;
      case "select":
        if (args.values === undefined) issue("values", "select needs at least one option value");
        break;
      case "press": {
        if (args.key === undefined) {
          issue("key", "press needs a key name");
          break;
        }
        const normalized = normalizeKey(args.key);
        if (!normalized.ok) issue("key", normalized.message ?? "unrecognized key name");
        break;
      }
      case "drag":
        if (args.source === undefined) issue("source", "drag needs a source reference");
        if (args.destination === undefined) {
          issue("destination", "drag needs a destination reference");
        }
        break;
      default:
        break;
    }
    if (args.factId !== undefined && args.action !== "fill" && args.action !== "type") {
      issue("factId", "a factId belongs on the action that enters the value");
    }
  });

type Args = z.infer<typeof schema>;

interface ResolvedValue {
  value: string;
  disclosure?: DisclosureContext | undefined;
  fact?: ApplicantFact | undefined;
}

type ValueResolution = ResolvedValue | { error: string };

/**
 * TOOLS.md: a supplied factId must resolve to the exact value being entered, and if both
 * a factId and a value are present they must agree. Provenance is recorded from the fact,
 * never from the model's assertion about where a value came from.
 */
function resolveValue(context: BrowserToolContext, args: Args): ValueResolution {
  const literal = args.value ?? "";
  if (args.factId === undefined) return { value: literal };
  const facts = context.session.facts;
  if (facts === undefined) {
    return {
      error:
        "This session has no authorized applicant facts, so a factId cannot be checked. Ask the user for the value and enter it directly.",
    };
  }
  const fact = facts.get(args.factId);
  if (fact === undefined) {
    return {
      error: `There is no authorized fact "${args.factId}". Check the facts you were given, or ask the user for this answer rather than guessing it.`,
    };
  }
  const factText = factValueText(fact.value);
  if (args.value !== undefined && args.value !== factText) {
    return {
      error: `The value you supplied does not match fact "${args.factId}". Enter the fact's own value, or drop the factId if this is a different answer.`,
    };
  }
  return { value: factText, fact, disclosure: { sensitivity: fact.sensitivity, fact } };
}

function toAction(args: Args, value: string): BrowserAction {
  switch (args.action) {
    case "click":
      return { kind: "click", target: args.target as NonNullable<Args["target"]> };
    case "fill":
      return { kind: "fill", target: args.target as NonNullable<Args["target"]>, value };
    case "type":
      return { kind: "type", target: args.target as NonNullable<Args["target"]>, text: value };
    case "select":
      return {
        kind: "select",
        target: args.target as NonNullable<Args["target"]>,
        values: args.values as string[],
      };
    case "check":
      return { kind: "check", target: args.target as NonNullable<Args["target"]> };
    case "uncheck":
      return { kind: "uncheck", target: args.target as NonNullable<Args["target"]> };
    case "press":
      return {
        kind: "press",
        key: normalizeKey(args.key as string).key,
        ...(args.target === undefined ? {} : { target: args.target }),
      };
    case "hover":
      return { kind: "hover", target: args.target as NonNullable<Args["target"]> };
    case "scroll":
      return {
        kind: "scroll",
        deltaX: args.deltaX ?? 0,
        deltaY: args.deltaY ?? 0,
        ...(args.target === undefined ? {} : { target: args.target }),
      };
    case "drag":
      return {
        kind: "drag",
        source: args.source as NonNullable<Args["source"]>,
        target: args.destination as NonNullable<Args["destination"]>,
      };
  }
}

const SCOPE_ORDER: readonly BrowserScope[] = [
  "browser:disclose",
  "browser:upload",
  "browser:interact",
];

function elementFor(record: ObservationRecord | undefined, args: Args): BrowserElement | undefined {
  const ref = args.target ?? args.destination;
  if (record === undefined || ref === undefined) return undefined;
  return record.targets.get(ref.ref)?.element;
}

function previewValue(element: BrowserElement | undefined, value: string, fact?: ApplicantFact) {
  if (element !== undefined && isCredentialElement(element)) return REDACTED;
  if (fact !== undefined && fact.sensitivity === "sensitive") return REDACTED;
  return value;
}

export function browserActTool(context: BrowserToolContext) {
  const { session } = context;
  session.configureResources({ facts: context.facts });

  const recordFor = (args: Args) => session.record(args.target?.tabId ?? args.destination?.tabId);

  // The permission the harness asks about is the one policy would name. Deriving it from
  // `decideActRequest` rather than from the action alone is what makes a cross-origin
  // frame ask about *its* origin instead of about an ordinary interaction.
  const projection = (args: Args): { scope: BrowserScope; pattern: string } => {
    const record = recordFor(args);
    const element = elementFor(record, args);
    const fallback = {
      scope:
        SCOPE_ORDER.find((scope) =>
          scopesForAction(toAction(args, args.value ?? ""), element).includes(scope),
        ) ?? ("browser:interact" as BrowserScope),
      pattern: actPattern(record?.observation.origin, element),
    };
    if (record === undefined) return fallback;
    const decision = decideActRequest(session.policy, {
      action: toAction(args, args.value ?? ""),
      observation: record.observation,
    });
    if (decision.kind !== "permission") return fallback;
    return { scope: decision.scopes[0] ?? fallback.scope, pattern: decision.pattern };
  };

  const scopeOf = (args: Args): BrowserScope => projection(args).scope;

  return tool({
    name: BROWSER_ACT_TOOL,
    description:
      "Interact with one control on the page: click, fill, type, select, check, uncheck, press a key, hover, scroll or drag. For ordinary page scrolling, omit target and set deltaY; use a target only for a specific nested scroll container. Other actions target a reference from the latest observation. This tool never submits, sends, purchases, deletes, consents or changes an account — those go through browser_submit.",
    inputSchema: schema,
    executionMode: "sequential",
    isConcurrencySafe: () => false,
    changesState: true,
    permissionScope: scopeOf,
    permissionPattern: (args) => projection(args).pattern,
    permissionDetails: (args): ToolPermissionDetails => {
      const record = recordFor(args);
      const element = elementFor(record, args);
      const resolved = resolveValue(context, args);
      const value = "error" in resolved ? undefined : resolved.value;
      const lines = [
        `origin: ${record?.observation.origin ?? "unknown"}`,
        `page: ${record?.observation.title ?? "not observed yet"}`,
        `control: ${element?.label ?? element?.name ?? element?.role ?? "unresolved"}`,
      ];
      if (value !== undefined && value.length > 0 && args.action !== "click") {
        lines.push(
          `value: ${previewValue(element, value, "error" in resolved ? undefined : resolved.fact)}`,
        );
      }
      if (!("error" in resolved) && resolved.fact !== undefined) {
        lines.push(`provenance: fact ${resolved.fact.id} (${resolved.fact.source.kind})`);
      } else if (args.action === "fill" || args.action === "type") {
        lines.push("provenance: a literal value, not an authorized fact");
      }
      return {
        description: `${args.action} on ${actPattern(record?.observation.origin, element)}`,
        preview: { kind: "text", lines },
      };
    },
    execute: async (args, { signal }): Promise<ToolResult> => {
      return runBrowserOperation({
        session,
        signal,
        validate: () => {
          const resolved = resolveValue(context, args);
          if ("error" in resolved) {
            session.note({ tool: BROWSER_ACT_TOOL, action: args.action, outcome: "refused" });
            return stop({ content: [{ type: "text", text: resolved.error }], isError: true });
          }
          return stage({ resolved, action: toAction(args, resolved.value) });
        },
        refresh: async ({ resolved, action }) => {
          const prepared = await prepareAction(session, {
            action,
            ...(args.target?.tabId === undefined ? {} : { tabId: args.target.tabId }),
            signal,
            ...(resolved.disclosure !== undefined
              ? { disclosure: resolved.disclosure }
              : disclosesPersonalData(elementFor(recordFor(args), args))
                ? { disclosure: { sensitivity: "personal" as const } }
                : {}),
          });
          if (prepared.kind === "ready") return stage(prepared);
          const message =
            args.action === "scroll" && args.target !== undefined && prepared.reason === "stale"
              ? `${prepared.message} To scroll the page viewport, retry browser_act with action "scroll", deltaY, and no target.`
              : prepared.message;
          session.note({
            tool: BROWSER_ACT_TOOL,
            action: args.action,
            ...(prepared.record === undefined
              ? {}
              : {
                  tabId: prepared.record.tabId,
                  url: prepared.record.observation.url,
                  revision: prepared.record.revision,
                }),
            outcome: prepared.reason,
            detail: message,
          });
          return stop({ content: [{ type: "text", text: message }], isError: true });
        },
        classify: (prepared) => stage(prepared.decision),
        project: (decision, prepared) => {
          if (decision.kind !== "permission") {
            return stop({
              content: [{ type: "text", text: "This interaction could not be classified." }],
              isError: true,
            });
          }
          return stage({
            scope: decision.scopes[0] ?? scopeOf(args),
            pattern: decision.pattern,
            prepared,
          });
        },
        drive: (driver, projection) => driver.act(projection.prepared.request, signal),
        settle: async (outcome, projection) => {
          if (outcome.navigation !== undefined)
            session.invalidate(projection.prepared.record.tabId);
          const after = await session.observe({ tabId: projection.prepared.record.tabId }, signal);
          return { outcome, after };
        },
        update: ({ outcome, after }, _driven, projection) => {
          const prepared = projection.prepared;
          if (outcome.ok && (args.action === "fill" || args.action === "type")) {
            const label =
              prepared.element?.label ??
              prepared.element?.name ??
              prepared.element?.role ??
              "field";
            const origin = prepared.record.observation.origin;
            if (origin !== undefined) {
              session.recordFilledField({
                label,
                origin,
                ...(args.factId === undefined ? {} : { factId: args.factId }),
              });
              if (args.factId !== undefined) {
                session.recordFactDisclosure({
                  url: prepared.record.observation.url,
                  factId: args.factId,
                  fieldName: label,
                });
              }
            }
          }
          session.note({
            tool: BROWSER_ACT_TOOL,
            action: args.action,
            tabId: after.tabId,
            url: after.observation.url,
            ...(after.observation.origin === undefined ? {} : { origin: after.observation.origin }),
            revision: after.revision,
            outcome: outcome.status,
            scope: projection.scope,
            pattern: projection.pattern,
          });
        },
        render: ({ outcome, after }, _driven, projection) => {
          const prepared = projection.prepared;
          const details: BrowserToolDetails = {
            kind: "action",
            tool: BROWSER_ACT_TOOL,
            action: args.action,
            status: outcome.status,
            tabId: after.tabId,
            url: after.observation.url,
            ...(prepared.element === undefined
              ? {}
              : {
                  target: prepared.element.label ?? prepared.element.name ?? prepared.element.ref,
                }),
            navigated: outcome.navigation !== undefined,
            scope: projection.scope,
            pattern: projection.pattern,
          };
          return {
            content: [
              {
                type: "text",
                text: [
                  outcomeText(outcome),
                  "",
                  observationHeadline(after),
                  ...observationFacts(after),
                  "",
                  observationText(after),
                ].join("\n"),
              },
            ],
            details,
            ...(outcome.ok ? {} : { isError: outcome.status === "failed" }),
          };
        },
        renderError: (error) => {
          session.note({ tool: BROWSER_ACT_TOOL, action: args.action, outcome: "error" });
          return { content: [{ type: "text", text: toolErrorText(error) }], isError: true };
        },
      });
    },
  });
}
