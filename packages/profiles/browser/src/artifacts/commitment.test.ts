import { describe, expect, test } from "bun:test";
import { SAMPLE_ORIGIN, SAMPLE_URL } from "../testing/samples.ts";
import {
  CommitmentLedger,
  type CommitmentRequest,
  type CommitPermit,
  commitmentKey,
} from "./commitment.ts";
import { type CommitEvidence, classifyCommitOutcome } from "./outcome.ts";

const REQUEST: CommitmentRequest = {
  intent: "submit-form",
  url: SAMPLE_URL,
  fingerprint: "submit-application:full_name,email",
};

function permitOf(ledger: CommitmentLedger, request: CommitmentRequest = REQUEST): CommitPermit {
  const authorization = ledger.authorize(request);
  if (!authorization.ok) throw new Error(`expected a permit, got ${authorization.reason}`);
  return authorization.permit;
}

function settle(ledger: CommitmentLedger, evidence: CommitEvidence, request = REQUEST): void {
  const attempt = ledger.begin(permitOf(ledger, request));
  ledger.settle(attempt, classifyCommitOutcome(evidence));
}

const UNCERTAIN: CommitEvidence = { interactionOccurred: true, lost: "timeout" };
const CONFIRMED: CommitEvidence = {
  interactionOccurred: true,
  confirmation: [{ kind: "external-id", value: "APP-4711" }],
};
const REJECTED: CommitEvidence = {
  interactionOccurred: true,
  failure: [{ kind: "validation-error", detail: "Email is required" }],
};

describe("commitment permits", () => {
  test("a commitment cannot be attempted without a permit the ledger issued", () => {
    const ledger = new CommitmentLedger();
    const authorization = ledger.authorize(REQUEST);
    expect(authorization.ok).toBe(true);
    const forged: CommitPermit = {
      commitmentId: "commit-1-deadbeef",
      key: commitmentKey(REQUEST.intent, SAMPLE_ORIGIN, REQUEST.fingerprint),
      intent: "submit-form",
      origin: SAMPLE_ORIGIN,
      url: SAMPLE_URL,
    };
    expect(() => ledger.begin(forged)).toThrow(TypeError);
  });

  test("a permit issued by another ledger is not a permit here", () => {
    const first = new CommitmentLedger();
    const second = new CommitmentLedger();
    expect(() => second.begin(permitOf(first))).toThrow(TypeError);
  });

  test("a permit is single use", () => {
    const ledger = new CommitmentLedger();
    const permit = permitOf(ledger);
    ledger.begin(permit);
    expect(() => ledger.begin(permit)).toThrow(TypeError);
  });

  test("a second permit is refused while one is outstanding or in flight", () => {
    const ledger = new CommitmentLedger();
    const permit = permitOf(ledger);
    const outstanding = ledger.authorize(REQUEST);
    expect(outstanding.ok).toBe(false);
    if (!outstanding.ok) expect(outstanding.reason).toBe("permit-outstanding");
    ledger.begin(permit);
    const inFlight = ledger.authorize(REQUEST);
    expect(inFlight.ok).toBe(false);
    if (!inFlight.ok) expect(inFlight.reason).toBe("attempt-in-flight");
  });

  test("an attempt settles once", () => {
    const ledger = new CommitmentLedger();
    const attempt = ledger.begin(permitOf(ledger));
    ledger.settle(attempt, classifyCommitOutcome(CONFIRMED));
    expect(() => ledger.settle(attempt, classifyCommitOutcome(CONFIRMED))).toThrow(TypeError);
  });

  test("a commitment targets a real origin", () => {
    const ledger = new CommitmentLedger();
    const result = ledger.authorize({ ...REQUEST, url: "file:///etc/passwd" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid-origin");
  });
});

describe("an unknown outcome cannot be retried", () => {
  test("the ledger mints no further permit for the same commitment", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, UNCERTAIN);
    const retry = ledger.authorize(REQUEST);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe("awaiting-reconciliation");
  });

  test("an unconfirmed but completed interaction is equally locked", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, { interactionOccurred: true });
    const retry = ledger.authorize(REQUEST);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe("awaiting-reconciliation");
  });

  test("claiming user approval does not unlock an unreconciled commitment", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, UNCERTAIN);
    const retry = ledger.authorize({ ...REQUEST, userReauthorized: true });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe("awaiting-reconciliation");
  });

  test("reconciliation needs observed evidence, not an assertion", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, UNCERTAIN);
    const [pending] = ledger.awaitingReconciliation();
    expect(pending).toBeDefined();
    const empty = ledger.reconcile(pending?.id ?? "", { status: "confirmed", evidence: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("insufficient-evidence");
    const weak = ledger.reconcile(pending?.id ?? "", {
      status: "confirmed",
      evidence: [{ kind: "confirmation-text", text: "probably fine" }],
    });
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.reason).toBe("insufficient-evidence");
  });

  test("observing the commitment happened closes it for good", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, UNCERTAIN);
    const [pending] = ledger.awaitingReconciliation();
    const resolved = ledger.reconcile(pending?.id ?? "", {
      status: "confirmed",
      evidence: [{ kind: "external-id", value: "APP-4711" }],
    });
    expect(resolved.ok).toBe(true);
    const retry = ledger.authorize({ ...REQUEST, userReauthorized: true });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe("already-confirmed");
  });

  test("observing it did not happen still needs the user before a retry", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, UNCERTAIN);
    const [pending] = ledger.awaitingReconciliation();
    expect(
      ledger.reconcile(pending?.id ?? "", {
        status: "failed",
        evidence: [{ kind: "error-text", detail: "No application exists for this posting" }],
      }).ok,
    ).toBe(true);
    const automatic = ledger.authorize(REQUEST);
    expect(automatic.ok).toBe(false);
    if (!automatic.ok) expect(automatic.reason).toBe("needs-user-approval");
    expect(ledger.authorize({ ...REQUEST, userReauthorized: true }).ok).toBe(true);
  });

  test("reconciling anything not awaiting reconciliation is refused", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, CONFIRMED);
    const [record] = ledger.all();
    const result = ledger.reconcile(record?.id ?? "", {
      status: "failed",
      evidence: [{ kind: "error-text", detail: "changed my mind" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-awaiting");
    expect(ledger.reconcile("commit-absent", { status: "failed", evidence: [] }).ok).toBe(false);
  });
});

describe("what the ledger does allow", () => {
  test("an observed rejection may be corrected and resubmitted", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, REJECTED);
    expect(ledger.authorize(REQUEST).ok).toBe(true);
  });

  test("a denied commitment may be offered again", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, { interactionOccurred: false, cancelled: true });
    expect(ledger.authorize(REQUEST).ok).toBe(true);
  });

  test("a different commitment is unaffected by an unknown one", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, UNCERTAIN);
    expect(ledger.authorize({ ...REQUEST, fingerprint: "a different application" }).ok).toBe(true);
    expect(ledger.authorize({ ...REQUEST, intent: "send" }).ok).toBe(true);
    expect(ledger.authorize({ ...REQUEST, url: "https://other.example.com/apply" }).ok).toBe(true);
  });

  test("the same commitment at the same origin is one commitment, whatever the path", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, UNCERTAIN);
    const sameOrigin = ledger.authorize({ ...REQUEST, url: `${SAMPLE_ORIGIN}/apply?step=2` });
    expect(sameOrigin.ok).toBe(false);
  });
});

describe("ledger bounds", () => {
  test("records are bounded but an unreconciled commitment is never forgotten", () => {
    const ledger = new CommitmentLedger({ maxRecords: 3 });
    settle(ledger, UNCERTAIN);
    for (let index = 0; index < 20; index += 1) {
      settle(ledger, CONFIRMED, { ...REQUEST, fingerprint: `other-${index}` });
    }
    expect(ledger.all().length).toBeLessThanOrEqual(4);
    expect(ledger.awaitingReconciliation()).toHaveLength(1);
    const retry = ledger.authorize(REQUEST);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe("awaiting-reconciliation");
  });

  test("a settled record reports its attempt count", () => {
    const ledger = new CommitmentLedger();
    settle(ledger, REJECTED);
    settle(ledger, CONFIRMED);
    const record = ledger.all().at(-1);
    expect(record?.attempts).toBe(2);
    expect(record?.phase).toBe("confirmed");
  });
});
