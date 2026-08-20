import { describe, expect, test } from "bun:test";
import { sampleActionOutcome, sampleObservation } from "../testing/samples.ts";
import {
  actionDisclosesValue,
  actionOutcomeSchema,
  actionTargets,
  browserActionSchema,
  completedOutcome,
  downloadDetails,
  failedOutcome,
  isUnknownOutcome,
  mayRetry,
  navigateRequestSchema,
  observeRequestSchema,
  readDownloadDetails,
  requiresReconciliation,
  submitRequestSchema,
  unknownOutcome,
  uploadRequestSchema,
  waitRequestSchema,
} from "./actions.ts";
import { assertJsonSerializable } from "./json.ts";
import { elementRefOf } from "./observation.ts";
import { authorizedDocumentId } from "./primitives.ts";

const observation = sampleObservation();
const target = elementRefOf(observation.elements[0] as never);
const before = { tabId: observation.tab.id, revision: observation.revision, url: observation.url };

describe("navigate request", () => {
  test("only http(s) URLs are navigable", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<b>x</b>",
      "javascript:alert(1)",
      "chrome://settings",
      "edge://extensions",
      "devtools://devtools/bundled/inspector.html",
      "about:blank",
    ]) {
      expect(navigateRequestSchema.safeParse({ kind: "url", url }).success).toBe(false);
    }
    expect(
      navigateRequestSchema.safeParse({ kind: "url", url: "https://jobs.example.com/apply" })
        .success,
    ).toBe(true);
  });

  test("history navigation takes no url", () => {
    expect(navigateRequestSchema.safeParse({ kind: "back" }).success).toBe(true);
    expect(
      navigateRequestSchema.safeParse({ kind: "back", url: "https://example.com" }).success,
    ).toBe(false);
  });
});

describe("observe request", () => {
  test("hidden nodes are not a requestable surface", () => {
    expect(observeRequestSchema.safeParse({ includeHidden: false }).success).toBe(true);
    expect(observeRequestSchema.safeParse({ includeHidden: true }).success).toBe(false);
  });

  test("bounds must be positive and inside the contract limits", () => {
    expect(observeRequestSchema.safeParse({ maxNodes: 0 }).success).toBe(false);
    expect(observeRequestSchema.safeParse({ maxNodes: 10_000_000 }).success).toBe(false);
    expect(observeRequestSchema.safeParse({ maxNodes: 50, maxTextChars: 5_000 }).success).toBe(
      true,
    );
  });
});

describe("browser action", () => {
  test("has no member that commits anything externally", () => {
    for (const kind of ["submit", "send", "purchase", "delete", "consent", "account-change"]) {
      expect(browserActionSchema.safeParse({ kind, target }).success).toBe(false);
    }
  });

  test("a bare ref string is never accepted where a reference belongs", () => {
    expect(browserActionSchema.safeParse({ kind: "click", target: "e1" }).success).toBe(false);
    expect(
      browserActionSchema.safeParse({ kind: "click", target: { ref: "e1", revision: 3 } }).success,
    ).toBe(false);
  });

  test("collects the references an action touches", () => {
    expect(actionTargets({ kind: "click", target })).toHaveLength(1);
    expect(actionTargets({ kind: "drag", source: target, target })).toHaveLength(2);
    expect(actionTargets({ kind: "scroll", deltaX: 0, deltaY: 10 })).toHaveLength(0);
  });

  test("knows which actions disclose a value", () => {
    expect(actionDisclosesValue({ kind: "fill", target, value: "Ada" })).toBe(true);
    expect(actionDisclosesValue({ kind: "click", target })).toBe(false);
  });

  test("select needs at least one option", () => {
    expect(browserActionSchema.safeParse({ kind: "select", target, values: [] }).success).toBe(
      false,
    );
  });
});

describe("wait request", () => {
  test("the value must match the condition", () => {
    expect(waitRequestSchema.safeParse({ condition: "time", value: 500 }).success).toBe(true);
    expect(waitRequestSchema.safeParse({ condition: "time", value: "500" }).success).toBe(false);
    expect(waitRequestSchema.safeParse({ condition: "text", value: "Thanks" }).success).toBe(true);
    expect(waitRequestSchema.safeParse({ condition: "text", value: 1 }).success).toBe(false);
    expect(waitRequestSchema.safeParse({ condition: "element", value: target }).success).toBe(true);
    expect(waitRequestSchema.safeParse({ condition: "element", value: "e1" }).success).toBe(false);
    expect(waitRequestSchema.safeParse({ condition: "network-idle" }).success).toBe(true);
    expect(waitRequestSchema.safeParse({ condition: "network-idle", value: 1 }).success).toBe(
      false,
    );
  });

  test("a wait is always bounded", () => {
    expect(waitRequestSchema.safeParse({ condition: "network-idle", timeoutMs: 0 }).success).toBe(
      false,
    );
    expect(
      waitRequestSchema.safeParse({ condition: "network-idle", timeoutMs: 3_600_000 }).success,
    ).toBe(false);
  });
});

describe("upload request", () => {
  test("a model-authored path is never a document id", () => {
    for (const id of [
      "../../etc/passwd",
      "/home/user/.ssh/id_rsa",
      "C:\\Users\\user\\secrets.txt",
      "~/resume.pdf",
      "docs/resume.pdf",
    ]) {
      expect(uploadRequestSchema.safeParse({ target, documentIds: [id] }).success).toBe(false);
    }
  });

  test("an authorized id is accepted and at least one is required", () => {
    expect(uploadRequestSchema.safeParse({ target, documentIds: ["doc-resume"] }).success).toBe(
      true,
    );
    expect(uploadRequestSchema.safeParse({ target, documentIds: [] }).success).toBe(false);
  });
});

describe("submit request", () => {
  test("only the classified intents are accepted", () => {
    expect(submitRequestSchema.safeParse({ target, intent: "submit-form" }).success).toBe(true);
    expect(submitRequestSchema.safeParse({ target, intent: "click" }).success).toBe(false);
  });
});

describe("action outcome", () => {
  test("ok is true exactly when the status is completed", () => {
    expect(actionOutcomeSchema.safeParse(sampleActionOutcome()).success).toBe(true);
    expect(
      actionOutcomeSchema.safeParse(sampleActionOutcome({ status: "unknown", ok: true })).success,
    ).toBe(false);
    expect(
      actionOutcomeSchema.safeParse(sampleActionOutcome({ status: "failed", ok: true })).success,
    ).toBe(false);
    expect(
      actionOutcomeSchema.safeParse(sampleActionOutcome({ status: "completed", ok: false }))
        .success,
    ).toBe(false);
  });

  test("unknown is representable and distinct from failed", () => {
    const uncertain = unknownOutcome({ message: "confirmation was lost", before });
    const failure = failedOutcome({ message: "the server rejected the form", before });
    expect(uncertain.status).toBe("unknown");
    expect(failure.status).toBe("failed");
    expect(uncertain.status).not.toBe(failure.status);
    expect(actionOutcomeSchema.safeParse(uncertain).success).toBe(true);
    expect(actionOutcomeSchema.safeParse(failure).success).toBe(true);
  });

  test("an unknown outcome is never ok and is never retryable", () => {
    const uncertain = unknownOutcome({ message: "confirmation was lost", before });
    expect(uncertain.ok).toBe(false);
    expect(isUnknownOutcome(uncertain)).toBe(true);
    expect(mayRetry(uncertain)).toBe(false);
    expect(requiresReconciliation(uncertain)).toBe(true);
  });

  test("a failed outcome may be retried; only uncertainty may not", () => {
    expect(mayRetry(failedOutcome({ message: "network error", before }))).toBe(true);
    expect(mayRetry(completedOutcome({ message: "filled", before }))).toBe(true);
  });

  test("the constructors omit absent fields rather than writing undefined into JSON", () => {
    const value = completedOutcome({ message: "filled", before });
    expect(Object.keys(value)).toEqual(["ok", "status", "message", "before"]);
    assertJsonSerializable(value, "outcome");
  });

  test("an outcome carries no unknown key and no non-serializable detail", () => {
    expect(
      actionOutcomeSchema.safeParse({ ...sampleActionOutcome(), handle: "page-1" }).success,
    ).toBe(false);
    expect(
      actionOutcomeSchema.safeParse(sampleActionOutcome({ details: { n: Number.NaN } as never }))
        .success,
    ).toBe(false);
  });

  test("an empty message is not an explanation", () => {
    expect(actionOutcomeSchema.safeParse(sampleActionOutcome({ message: "" })).success).toBe(false);
  });
});

describe("download reporting", () => {
  test("a download is reported by metadata only", () => {
    const details = downloadDetails({
      basename: "offer.pdf",
      mimeType: "application/pdf",
      bytes: 1024,
    });
    expect(readDownloadDetails(details)?.basename).toBe("offer.pdf");
    expect(JSON.stringify(details)).not.toContain("/home");
  });

  test("a download report has nowhere to put a local path", () => {
    expect(() => downloadDetails({ basename: "/home/user/offer.pdf" })).toThrow();
    expect(readDownloadDetails({ download: { basename: "a.pdf", path: "/tmp/a.pdf" } })).toBe(
      undefined,
    );
  });
});

describe("document ids", () => {
  test("a path can never be minted into a document id", () => {
    expect(() => authorizedDocumentId("../secrets")).toThrow();
    expect(authorizedDocumentId("doc-resume")).toBe(
      "doc-resume" as ReturnType<typeof authorizedDocumentId>,
    );
  });
});
