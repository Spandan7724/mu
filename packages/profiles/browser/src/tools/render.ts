// How a page reaches the model. Two rules shape every function here: page-derived text is
// wrapped as untrusted (SECURITY §5, BD11), and nothing credential-shaped is rendered at
// all — not its value, not a truncated value, not a screenshot of the page holding it.
import type { ToolResultContent } from "@mu/ai";
import type { ActionOutcome } from "../contracts/actions.ts";
import { readDownloadDetails } from "../contracts/actions.ts";
import {
  type BrowserElement,
  type BrowserObservation,
  isCredentialElement,
} from "../contracts/observation.ts";
import { REDACTED } from "../contracts/secret.ts";
import { describeInjection, untrusted } from "../policy/untrusted.ts";
import { elementCaption, OBSERVATION_BUDGET, rankElements } from "./observation.ts";
import type { ObservationRecord } from "./session.ts";

const SCREENSHOT_BLOCKING_RISKS = new Set(["password", "captcha"]);
const CREDENTIAL_ENTRY_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/** SECURITY §11: credential entry is never captured; a navigation link named Sign in is safe. */
export function screenshotSuppressed(observation: BrowserObservation): boolean {
  if (observation.risks.some((risk) => SCREENSHOT_BLOCKING_RISKS.has(risk))) return true;
  return observation.elements.some(
    (element) =>
      isCredentialElement(element) &&
      (element.inputType !== undefined || CREDENTIAL_ENTRY_ROLES.has(element.role ?? "")),
  );
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stateOf(element: BrowserElement): string[] {
  const parts: string[] = [];
  if (element.disabled === true) parts.push("disabled");
  if (element.readonly === true) parts.push("read-only");
  if (element.required === true) parts.push("required");
  if (element.checked === "mixed") parts.push("partially checked");
  else if (element.checked === true) parts.push("checked");
  else if (element.checked === false) parts.push("unchecked");
  return parts;
}

function displayValue(element: BrowserElement): string | undefined {
  if (isCredentialElement(element)) return REDACTED;
  if (element.value === undefined || element.value.length === 0) return undefined;
  return clip(element.value, OBSERVATION_BUDGET.maxValueChars);
}

export function describeElement(element: BrowserElement): string {
  const parts = [`[${element.ref}] ${element.role ?? "control"} "${elementCaption(element)}"`];
  const value = displayValue(element);
  if (value !== undefined) parts.push(`= ${JSON.stringify(value)}`);
  if (element.options !== undefined && element.options.length > 0) {
    const labels = element.options.slice(0, 12).map((option) => option.label);
    const more = element.options.length - labels.length;
    parts.push(`options: ${labels.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  const state = stateOf(element);
  if (state.length > 0) parts.push(`(${state.join(", ")})`);
  if (element.frameId !== undefined) parts.push(`in frame ${element.frameId}`);
  if (element.risk !== undefined && element.risk.length > 0) {
    parts.push(`risk: ${element.risk.join(", ")}`);
  }
  return parts.join(" ");
}

export interface ObservationTextOptions {
  focus?: string | undefined;
  maxElements?: number | undefined;
}

/** The page as untrusted data: bounded by whole elements, never by cutting one in half. */
export function observationText(
  record: ObservationRecord,
  options: ObservationTextOptions = {},
): string {
  const observation = record.observation;
  const limit = Math.min(
    options.maxElements ?? OBSERVATION_BUDGET.maxRenderedElements,
    OBSERVATION_BUDGET.maxRenderedElements,
  );
  const ordered = rankElements(observation.elements, options.focus);
  const lines: string[] = [];
  let budget = OBSERVATION_BUDGET.maxRenderedTextChars;
  let shown = 0;
  for (const element of ordered) {
    if (shown >= limit) break;
    const line = describeElement(element);
    if (line.length > budget) break;
    budget -= line.length + 1;
    lines.push(line);
    shown += 1;
  }
  const omitted = observation.elements.length - shown;

  const body = [
    clip(observation.summary, OBSERVATION_BUDGET.maxSummaryChars),
    "",
    ...lines,
    ...(omitted > 0
      ? ["", `${omitted} further control(s) not shown; narrow with focus or scroll.`]
      : []),
  ]
    .join("\n")
    .trim();

  return untrusted(body, "page-text", observation.origin).toString();
}

export function observationHeadline(record: ObservationRecord): string {
  const observation = record.observation;
  const controls = observation.elements.length;
  return `Observed "${clip(observation.title, 120)}" · ${controls} control${
    controls === 1 ? "" : "s"
  } · ${observation.url} · revision ${observation.revision}`;
}

/** Page facts the model needs that are Mu's own statements, not the page's words. */
export function observationFacts(record: ObservationRecord): string[] {
  const observation = record.observation;
  const facts: string[] = [
    `tab ${observation.tab.id}${observation.tab.attached ? "" : " (detached)"} · origin ${
      observation.origin ?? "unknown"
    }`,
  ];
  if (observation.frames.length > 0) {
    const cross = observation.frames.filter((frame) => frame.crossOrigin);
    const detail =
      cross.length > 0
        ? `, ${cross.length} cross-origin: ${cross
            .map((frame) => `${frame.id} (${frame.origin ?? frame.url})`)
            .join(", ")}`
        : "";
    facts.push(`${observation.frames.length} frame(s)${detail}`);
  }
  if (observation.risks.length > 0) facts.push(`risk markers: ${observation.risks.join(", ")}`);
  if (observation.truncated !== undefined) {
    facts.push(
      `the page exceeded the observation budget: ${observation.truncated.nodesOmitted} node(s) and ${observation.truncated.textCharsOmitted} character(s) were left out`,
    );
  }
  if (record.injections.length > 0) facts.push(describeInjection(record.injections));
  return facts;
}

export function screenshotContent(record: ObservationRecord): ToolResultContent[] {
  const screenshot = record.observation.screenshot;
  if (screenshot === undefined || screenshotSuppressed(record.observation)) return [];
  return [{ type: "image", mimeType: screenshot.mimeType, data: screenshot.data, evictable: true }];
}

/** ARCHITECTURE §9's last visible step: what changed, and whether the page moved. */
export function outcomeText(outcome: ActionOutcome): string {
  const lines = [outcome.message];
  if (outcome.navigation !== undefined) {
    lines.push(
      `The page navigated from ${outcome.navigation.from} to ${outcome.navigation.to}${
        outcome.navigation.newOrigin === true ? " (a different origin)" : ""
      }.`,
    );
  } else if (outcome.after !== undefined && outcome.after.url !== outcome.before.url) {
    lines.push(`The page is now at ${outcome.after.url}.`);
  }
  if (outcome.dialog !== undefined) {
    const dialog = outcome.dialog;
    lines.push(
      `The page raised a ${dialog.kind} dialog, which was ${dialog.handled}. It asked:`,
      untrusted(dialog.message, "page-text").toString(),
    );
    if (dialog.handled === "dismissed" && dialog.kind !== "alert") {
      lines.push(
        "Nothing was agreed to. A dialog is answered only when the user approves that answer in advance, so ask before treating this as done.",
      );
    }
  }
  const download = readDownloadDetails(outcome.details);
  if (download !== undefined) {
    // Metadata only, deliberately. The bytes are untrusted, stay in the private artifact
    // root, are never executed, and their location is never model-visible.
    const size = download.bytes === undefined ? "" : ` · ${download.bytes} bytes`;
    const type = download.mimeType === undefined ? "" : ` · ${download.mimeType}`;
    lines.push(`The page downloaded ${download.basename}${type}${size}.`);
    lines.push("Mu holds the file privately; it is not opened, run, or readable from here.");
  }
  if (outcome.status === "unknown") {
    lines.push(
      "The result is uncertain. Observe the page and report what it says; do not repeat the action to find out.",
    );
  }
  return lines.join("\n");
}
