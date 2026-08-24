// What the browser toolset is built from. The tools own no state: everything durable
// lives in the session's reference ledger, and everything decidable lives in policy.
import type { BrowserArtifactStore } from "../artifacts/store.ts";
import type { DisclosureRecord } from "../contracts/disclosure.ts";
import type { FactLookup } from "../data/facts.ts";
import type { BrowserToolSession } from "./session.ts";

/**
 * Where a commitment's receipt is written, when the profile configured a private
 * artifact root. Without it a commitment still happens and is still reported — the
 * receipt is the durable record, not the safety mechanism.
 */
export interface BrowserReceiptSink {
  sessionId: string;
  store: BrowserArtifactStore;
  taskId?: string | undefined;
  // Read at write time: what was disclosed is only fully known once the form is filled.
  disclosures?: (() => readonly DisclosureRecord[]) | undefined;
}

export interface BrowserToolContext {
  session: BrowserToolSession;
  /**
   * Applicant facts, when the profile has any. A `factId` argument is checked against
   * this; without it, the model may still enter a literal value, and the disclosure
   * permission is what asks about it.
   */
  facts?: FactLookup | undefined;
  receipts?: BrowserReceiptSink | undefined;
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
      screenshot: "attached" | "suppressed" | "unavailable" | "none";
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
