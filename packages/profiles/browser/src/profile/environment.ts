// What a browser session records about itself. B1 made `SessionEnvironment` a
// bounded string map validated before it reaches a header, so everything here is
// a short, resumable fact — never a document path, an origin list that a page can
// grow, a token, or anything derived from page content.
import { type AgentMessage, customMessage, type SessionEnvironment } from "@mu/core";
import type { ResolvedBrowserProfileOptions } from "./options.ts";

// Kept well inside SESSION_ENVIRONMENT_LIMITS.maxValueLength so a long allow-list
// is summarized rather than truncated mid-origin.
const MAX_LISTED_ORIGINS = 20;

export interface BrowserEnvironmentInput {
  options: ResolvedBrowserProfileOptions;
  dataRoot: string;
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
    documents: String(options.documents.length),
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
    ...(options.extensionToken === undefined ? {} : { extensionToken: "configured" }),
  };
}

export function environmentMessage(environment: SessionEnvironment): AgentMessage {
  const lines = Object.entries(environment).map(([key, value]) => `${key}: ${value}`);
  return customMessage("browser-environment", lines.join("\n"));
}

export function connectionMessage(description: string, mode: string): AgentMessage {
  return customMessage(
    "browser-connection",
    mode === "extension"
      ? `The browser connection is ${description}. It is not open yet: the user approves the tab in their browser the first time you need it.`
      : `The browser connection is ${description}. Mu owns this browser and will close it when the session ends.`,
  );
}
