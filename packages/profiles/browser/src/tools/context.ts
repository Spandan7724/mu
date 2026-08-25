// Tools receive one stateful capability: the task session. Facts, documents,
// disclosures, commitments, takeover and receipts all live behind it.

import type { AuthorizedDocumentStore } from "../artifacts/documents.ts";
import type { FactLookup } from "../data/facts.ts";
import type { BrowserReceiptSink, BrowserTaskSession } from "./session.ts";

export type { BrowserReceiptSink } from "./session.ts";

export interface BrowserToolContext {
  session: BrowserTaskSession;
  /** @deprecated Configure these on BrowserTaskSession. */
  facts?: FactLookup | undefined;
  /** @deprecated Configure these on BrowserTaskSession. */
  documents?: AuthorizedDocumentStore | undefined;
  /** @deprecated Configure these on BrowserTaskSession. */
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
      plannedFills?: number | undefined;
      unresolvedQuestions?: number | undefined;
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
