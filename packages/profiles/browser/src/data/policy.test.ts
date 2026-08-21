import { describe, expect, test } from "bun:test";
import type { ApplicantFact, ApplicantPolicy } from "../contracts/applicant.ts";
import type { FactLookup } from "./facts.ts";
import { CONSEQUENTIAL_FIELDS, declineOption, resolvePolicy } from "./policy.ts";
import { policyFact } from "./samples.ts";

// Policy answers now live in the fact collection and are referenced by id, so a test
// policy needs the matching lookup.
function lookupOf(...facts: ApplicantFact[]): FactLookup {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  return {
    get: (id) => byId.get(id),
    byField: (field) => facts.filter((fact) => fact.field === field),
    factFor: (field) => facts.find((fact) => fact.field === field),
    documents: () => [],
    trace: (fact) => ({
      factId: fact.id,
      field: fact.field,
      kind: fact.source.kind,
      chain: [fact.id],
      documentIds: [],
      userStated: fact.source.kind === "user",
      grounded: true,
    }),
  };
}

const NO_FACTS = lookupOf();

const DEMOGRAPHIC_OPTIONS = [
  { label: "", value: "" },
  { label: "Decline to self-identify", value: "decline" },
  { label: "Female", value: "female" },
  { label: "Male", value: "male" },
];

function request(field: string, required = false, options = DEMOGRAPHIC_OPTIONS) {
  return { field, label: field, required, options };
}

describe("consequential fields", () => {
  test("without a policy every one of them is a question, never a default", () => {
    for (const field of CONSEQUENTIAL_FIELDS) {
      const decision = resolvePolicy({}, NO_FACTS, { field, label: field, required: true });
      expect(decision.kind).toBe("ask");
    }
  });

  test("a policy answer is used and is attributed to the policy", () => {
    const fact = policyFact("work_authorization", "yes", "fact-auth");
    const policy: ApplicantPolicy = { workAuthorizationFactId: fact.id };
    const decision = resolvePolicy(policy, lookupOf(fact), request("work_authorization", true));
    expect(decision.kind).toBe("answer");
    if (decision.kind !== "answer") return;
    expect(decision.fact.id).toBe("fact-auth");
    expect(decision.reason).toContain("policy");
  });

  test("a required consequential field with no policy still asks rather than guessing", () => {
    const decision = resolvePolicy({}, NO_FACTS, request("desired_salary", true));
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") return;
    expect(decision.reason).toContain("never inferred");
  });

  test("one policy slot does not answer another", () => {
    const fact = policyFact("relocation", "yes", "fact-reloc");
    const policy: ApplicantPolicy = { relocationFactId: fact.id };
    const facts = lookupOf(fact);
    expect(resolvePolicy(policy, facts, request("sponsorship")).kind).toBe("ask");
    expect(resolvePolicy(policy, facts, request("relocation")).kind).toBe("answer");
  });
});

describe("voluntary demographics", () => {
  test("with no declared behaviour the answer is a question", () => {
    const decision = resolvePolicy({}, NO_FACTS, request("gender"));
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") return;
    expect(decision.reason).toContain("explicit instruction");
  });

  test("an explicit answer is honoured", () => {
    const fact = policyFact("gender", "female", "fact-gender");
    const policy: ApplicantPolicy = { demographicAnswerFactIds: [fact.id] };
    const decision = resolvePolicy(policy, lookupOf(fact), request("gender"));
    expect(decision.kind).toBe("answer");
    if (decision.kind !== "answer") return;
    expect(decision.fact.id).toBe("fact-gender");
  });

  test("declining uses the page's own decline option", () => {
    const decision = resolvePolicy(
      { defaultDemographicBehavior: "decline" },
      NO_FACTS,
      request("gender"),
    );
    expect(decision.kind).toBe("decline");
    if (decision.kind !== "decline") return;
    expect(decision.value).toBe("decline");
    expect(decision.label).toBe("Decline to self-identify");
  });

  test("declining an optional question with no decline option omits it", () => {
    const decision = resolvePolicy({ defaultDemographicBehavior: "decline" }, NO_FACTS, {
      field: "ethnicity",
      label: "Race or ethnicity",
      required: false,
    });
    expect(decision.kind).toBe("omit");
  });

  test("declining a required question with no decline option asks rather than answering", () => {
    const decision = resolvePolicy({ defaultDemographicBehavior: "decline" }, NO_FACTS, {
      field: "ethnicity",
      label: "Race or ethnicity",
      required: true,
    });
    expect(decision.kind).toBe("ask");
  });

  test("omit-when-optional omits an optional question and asks about a required one", () => {
    const policy: ApplicantPolicy = { defaultDemographicBehavior: "omit-when-optional" };
    expect(resolvePolicy(policy, NO_FACTS, request("veteran_status", false)).kind).toBe("omit");
    expect(resolvePolicy(policy, NO_FACTS, request("veteran_status", true)).kind).toBe("ask");
  });

  test("no branch ever produces a demographic value the user did not supply", () => {
    const behaviours: (ApplicantPolicy["defaultDemographicBehavior"] | undefined)[] = [
      undefined,
      "ask",
      "decline",
      "omit-when-optional",
    ];
    for (const behavior of behaviours) {
      for (const required of [true, false]) {
        for (const field of ["gender", "ethnicity", "veteran_status", "disability_status"]) {
          const policy: ApplicantPolicy =
            behavior === undefined ? {} : { defaultDemographicBehavior: behavior };
          const decision = resolvePolicy(policy, NO_FACTS, request(field, required));
          if (decision.kind === "answer") throw new Error("a demographic value was invented");
          if (decision.kind === "decline") expect(decision.value).toBe("decline");
        }
      }
    }
  });
});

describe("decline detection", () => {
  test("common decline phrasings are recognized", () => {
    for (const label of [
      "Decline to self-identify",
      "I prefer not to answer",
      "I do not wish to disclose",
      "Choose not to disclose",
    ]) {
      expect(declineOption([{ label }])?.label).toBe(label);
    }
  });

  test("an ordinary option is not mistaken for a decline", () => {
    expect(declineOption([{ label: "Female" }, { label: "Male" }])).toBeUndefined();
  });
});

describe("ungoverned fields", () => {
  test("a field with no policy meaning is not answered by the policy layer", () => {
    expect(resolvePolicy({}, NO_FACTS, request("city")).kind).toBe("ask");
  });
});
