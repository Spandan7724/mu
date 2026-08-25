// What a browser session records about itself. B1 made `SessionEnvironment` a
// bounded string map validated before it reaches a header, so everything here is
// a short, resumable fact — never a document path, an origin list that a page can
// grow, a token, or anything derived from page content.
import { type AgentMessage, customMessage, type SessionEnvironment } from "@mu/core";
import { redactFactValue } from "../contracts/applicant.ts";
import type { AuthorizedDocumentSummary } from "../contracts/documents.ts";
import type { FactStore } from "../data/facts.ts";
import { factValueText } from "../data/facts.ts";
import { classifyNavigationUrl } from "../policy/origin.ts";
import type { ResolvedBrowserProfileOptions } from "./options.ts";

// Kept well inside SESSION_ENVIRONMENT_LIMITS.maxValueLength so a long allow-list
// is summarized rather than truncated mid-origin.
const MAX_LISTED_ORIGINS = 20;

export interface BrowserEnvironmentInput {
  options: ResolvedBrowserProfileOptions;
  dataRoot: string;
  documentCount?: number;
  platform?: string;
}

export function browserEnvironment(input: BrowserEnvironmentInput): SessionEnvironment {
  const { options } = input;
  const listed = options.allowedOrigins.slice(0, MAX_LISTED_ORIGINS);
  return {
    surface: "browser",
    connection: options.connection,
    browser: options.browser,
    headless: String(options.headless),
    dataRoot: input.dataRoot,
    platform: input.platform ?? process.platform,
    documents: String(input.documentCount ?? options.documents.length),
    ...(options.workspaceRoot === undefined
      ? {}
      : { fileScope: "direct uploadable files in the launch directory" }),
    allowedOrigins:
      options.allowedOrigins.length === 0
        ? "none beyond the task's own origin"
        : listed.join(" ") +
          (options.allowedOrigins.length > listed.length
            ? ` (+${options.allowedOrigins.length - listed.length} more)`
            : ""),
    ...(options.userDataDir === undefined ? {} : { browserProfile: options.userDataDir }),
    ...(options.artifactRoot === undefined ? {} : { artifactRoot: options.artifactRoot }),
    ...(options.applicantProfile === undefined ? {} : { applicantProfile: "configured" }),
  };
}

export function environmentMessage(environment: SessionEnvironment): AgentMessage {
  const lines = Object.entries(environment).map(([key, value]) => `${key}: ${value}`);
  return customMessage("browser-environment", lines.join("\n"));
}

export function connectionMessage(description: string, _mode: string): AgentMessage {
  return customMessage(
    "browser-connection",
    `The browser connection is ${description}. Mu owns this browser and will close it when the session ends.`,
  );
}

export function documentsMessage(documents: readonly AuthorizedDocumentSummary[]): AgentMessage {
  return customMessage(
    "browser-documents",
    documents.length === 0
      ? "No uploadable files are available in the launch directory. Do not claim that a local file can be used."
      : [
          "Files available from the launch directory. Upload only by the listed id; paths outside this set are unavailable.",
          ...documents.map(
            (document) =>
              `id=${document.id} | name=${document.basename} | type=${document.mimeType} | bytes=${document.bytes}`,
          ),
        ].join("\n"),
  );
}

export function applicantFactsMessage(facts: FactStore): AgentMessage {
  const entries = facts.all().map((fact) => {
    const value = redactFactValue(fact);
    const rendered =
      fact.sensitivity === "sensitive" ? "[withheld; use factId]" : factValueText(value);
    return [
      `id=${fact.id}`,
      `field=${fact.field}`,
      `value=${rendered}`,
      `sensitivity=${fact.sensitivity}`,
      `confidence=${fact.confidence}`,
      `source=${fact.source.kind}`,
    ].join(" | ");
  });
  return customMessage(
    "browser-applicant-facts",
    [
      "Authorized applicant facts. Use factId when entering one; do not invent a missing value.",
      ...entries,
    ].join("\n"),
  );
}

function textBlocks(message: AgentMessage): string[] {
  if (message.role !== "user") return [];
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

export function taskUrlsFromMessages(messages: readonly AgentMessage[]): string[] {
  const urls: string[] = [];
  for (const text of messages.flatMap(textBlocks)) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      let candidate = match[0].replace(/[),.;!?\]}]+$/g, "");
      const check = classifyNavigationUrl(candidate);
      if (!check.ok) continue;
      candidate = check.url;
      if (!urls.includes(candidate)) urls.push(candidate);
    }
  }
  return urls;
}
