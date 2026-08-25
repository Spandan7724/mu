// B8/BD22: ../carryover.test.ts proves what a well-behaved caller produces is
// secret-free. This proves the contract itself refuses a value even if something
// upstream tried to sneak one in — the absence of values is enforced structurally by
// `z.strictObject`, not merely by convention, so the guarantee survives a caller bug.
import { describe, expect, test } from "bun:test";
import type { BrowserCarryover } from "../contracts/carryover.ts";
import { browserCarryoverSchema } from "../contracts/carryover.ts";
import { SAMPLE_ORIGIN, SAMPLE_REVISION, SAMPLE_TAB, SAMPLE_URL } from "./samples.ts";

function validCarryover(): BrowserCarryover {
  return {
    connection: { mode: "persistent", browser: "chrome", phase: "ready" },
    active: {
      tabId: SAMPLE_TAB,
      url: SAMPLE_URL,
      origin: SAMPLE_ORIGIN,
      title: "Apply",
      revision: SAMPLE_REVISION,
    },
    allowedOrigins: [SAMPLE_ORIGIN],
    completedSteps: [],
    outstandingSteps: [],
    filledFields: [{ label: "Email address", factId: "fact-email", origin: SAMPLE_ORIGIN }],
    unresolvedQuestions: [],
    uploadedDocumentIds: [],
  };
}

describe("the carryover contract rejects a value even if a caller tries to smuggle one in", () => {
  test("a plain valid carryover still parses (sanity)", () => {
    expect(browserCarryoverSchema.safeParse(validCarryover()).success).toBe(true);
  });

  test("a value on a filled field is refused, not silently accepted", () => {
    const withValue = {
      ...validCarryover(),
      filledFields: [
        {
          label: "Email address",
          factId: "fact-email",
          origin: SAMPLE_ORIGIN,
          value: "ada@example.com",
        },
      ],
    };
    expect(browserCarryoverSchema.safeParse(withValue).success).toBe(false);
  });

  test("an arbitrary extra top-level field is refused: the schema names everything that survives compaction", () => {
    const extended = { ...validCarryover(), secretNote: "do not persist me" };
    expect(browserCarryoverSchema.safeParse(extended).success).toBe(false);
  });

  test("a credential-shaped string is refused wherever the schema does not expect one", () => {
    const withPassword = {
      ...validCarryover(),
      active: { ...validCarryover().active, password: "hunter2" },
    };
    expect(browserCarryoverSchema.safeParse(withPassword).success).toBe(false);
  });
});
