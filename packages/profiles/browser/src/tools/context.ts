// What the browser toolset is built from. The tools own no state: everything durable
// lives in the session's reference ledger, and everything decidable lives in policy.
import type { FactLookup } from "../data/facts.ts";
import type { BrowserToolSession } from "./session.ts";

export interface BrowserToolContext {
  session: BrowserToolSession;
  /**
   * Applicant facts, when the profile has any. A `factId` argument is checked against
   * this; without it, the model may still enter a literal value, and the disclosure
   * permission is what asks about it.
   */
  facts?: FactLookup | undefined;
}

/** Details attached to a tool result for renderers and the session log. Serializable. */
export type BrowserToolDetails =
  | {
      kind: "observation";
      tabId: string;
      revision: number;
      url: string;
      origin?: string | undefined;
      title: string;
      controls: number;
      frames: number;
      risks: string[];
      injections: number;
      screenshot: "attached" | "suppressed" | "none";
      truncated?: { nodesOmitted: number; textCharsOmitted: number } | undefined;
    }
  | {
      kind: "action";
      tool: string;
      action: string;
      status: string;
      tabId?: string | undefined;
      url?: string | undefined;
      target?: string | undefined;
      navigated?: boolean | undefined;
      scope?: string | undefined;
      pattern?: string | undefined;
    }
  | {
      kind: "tabs";
      action: string;
      tabs: { id: string; title: string; url: string; active: boolean; attached: boolean }[];
      activeTabId?: string | undefined;
    }
  | {
      kind: "takeover";
      reason: string;
      tabId?: string | undefined;
      url?: string | undefined;
    };
