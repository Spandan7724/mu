import { describe, expect, test } from "bun:test";
import { elementRefId } from "../contracts/primitives.ts";
import { createFactStore } from "./facts.ts";
import { MATCH_CONFIDENCE_THRESHOLD, matchElement, matchElements } from "./match.ts";
import { applyFormElements, element, hostileElements, SAMPLE_TIME } from "./samples.ts";

function facts() {
  const store = createFactStore({ now: () => SAMPLE_TIME });
  store.add({
    field: "email",
    value: "ada.testwell@example.invalid",
    source: { kind: "user" },
    confidence: "exact",
    id: "fact-email",
  });
  store.add({
    field: "full_name",
    value: "Ada Testwell",
    source: { kind: "user" },
    confidence: "exact",
    id: "fact-name",
  });
  store.add({
    field: "city",
    value: "Springfield",
    source: { kind: "user" },
    confidence: "exact",
    id: "fact-city",
  });
  return store;
}

describe("well-marked fields", () => {
  test("recognizes a hiring-country work authorization select", () => {
    const store = facts();
    store.add({
      field: "work_authorization",
      value: "yes",
      source: { kind: "user" },
      confidence: "exact",
      id: "fact-auth",
    });
    const match = matchElement(
      element({
        role: "combobox",
        inputType: "select-one",
        label: "Are you authorized to work in the hiring country? *",
        required: true,
        options: [{ label: "Yes" }, { label: "No" }],
      }),
      store,
    );

    expect(match.field).toBe("work_authorization");
    expect(match.status).toBe("matched");
  });

  test("a labelled field matches its fact and explains why", () => {
    const match = matchElement(element({ label: "Email address", inputType: "email" }), facts());
    expect(match.status).toBe("matched");
    expect(match.field).toBe("email");
    expect(match.fact?.id).toBe("fact-email");
    expect(match.confidence).toBeGreaterThanOrEqual(MATCH_CONFIDENCE_THRESHOLD);
    expect(match.reason).toContain("Email address");
    expect(match.evidence.join(" ")).toContain('input type "email" agrees');
  });

  test("a snake_case accessible name resolves through the same aliases", () => {
    const match = matchElement(element({ name: "email_address" }), facts());
    expect(match.field).toBe("email");
    expect(match.status).toBe("matched");
  });

  test("a contradicting input type pushes the score below the fill line", () => {
    const match = matchElement(element({ label: "Email address", inputType: "date" }), facts());
    expect(match.status).not.toBe("matched");
    expect(match.evidence.join(" ")).toContain("contradicts");
  });

  test("a recognized field with no fact is reported as such, not filled", () => {
    const match = matchElement(element({ label: "Notice period" }), facts());
    expect(match.status).toBe("no-fact");
    expect(match.fact).toBeUndefined();
    expect(match.reason).toContain("not in your resume");
  });

  test("a label naming nothing in the catalog is unrecognized", () => {
    const match = matchElement(element({ label: "Favourite sandwich" }), facts());
    expect(match.status).toBe("unrecognized");
    expect(match.confidence).toBe(0);
  });
});

describe("hostile markup", () => {
  test("an unlabelled control matches nothing", () => {
    const match = matchElement(element({ ref: elementRefId("e-bare"), required: true }), facts());
    expect(match.status).toBe("unnamed");
    expect(match.confidence).toBe(0);
    expect(match.reason).toContain("no label");
  });

  test("a dangling `for` leaves the control unnamed, and it stays unmatched", () => {
    // The driver reports what the accessibility tree exposes; a label pointing at a
    // non-existent id contributes nothing, so the element simply arrives without a name.
    const match = matchElement(element({ ref: elementRefId("e-dangling") }), facts());
    expect(match.status).toBe("unnamed");
  });

  test("a placeholder alone cannot authorize a fill", () => {
    const match = matchElement(element({ placeholder: "Your full name" }), facts());
    expect(match.status).not.toBe("matched");
    expect(match.confidence).toBeLessThan(MATCH_CONFIDENCE_THRESHOLD);
    expect(match.evidence.join(" ")).toContain("placeholder is not an accessible name");
  });

  test("duplicate labels demote both controls to ambiguous", () => {
    const matches = matchElements(
      [
        element({ ref: elementRefId("e-a"), label: "Email address" }),
        element({ ref: elementRefId("e-b"), label: "Email address" }),
      ],
      facts(),
    );
    expect(matches.map((match) => match.status)).toEqual(["ambiguous", "ambiguous"]);
    for (const match of matches) {
      expect(match.fact).toBeUndefined();
      expect(match.reason).toContain("more than one control");
    }
  });

  test("a single control with that label still matches", () => {
    const matches = matchElements([element({ label: "Email address" })], facts());
    expect(matches[0]?.status).toBe("matched");
  });

  test("a visually hidden control is matched on its name like any other", () => {
    const match = matchElement(element({ label: "City" }), facts());
    expect(match.status).toBe("matched");
    expect(match.field).toBe("city");
  });

  test("a credential field is refused before anything else is considered", () => {
    const match = matchElement(
      element({ label: "Account password", inputType: "password" }),
      facts(),
    );
    expect(match.status).toBe("refused");
    expect(match.refusal).toBe("credential");
  });

  test("a hidden input is never filled", () => {
    const match = matchElement(element({ label: "Email address", inputType: "hidden" }), facts());
    expect(match.status).toBe("refused");
    expect(match.refusal).toBe("hidden");
  });

  test("hidden fields harvesting unrelated identity never match", () => {
    const matches = matchElements(hostileElements(), facts());
    const byRef = new Map(matches.map((match) => [match.ref.ref, match]));
    for (const ref of ["e-govid", "e-dob", "e-bank", "e-maiden", "e-salary-history"]) {
      const match = byRef.get(elementRefId(ref));
      expect(match?.status).toBe("refused");
      expect(match?.fact).toBeUndefined();
    }
  });

  test("nothing in the hostile page produces a fillable match", () => {
    const matches = matchElements(hostileElements(), facts());
    expect(matches.filter((match) => match.status === "matched")).toHaveLength(0);
  });

  test("a disabled or read-only control is not filled", () => {
    expect(matchElement(element({ label: "City", disabled: true }), facts()).refusal).toBe(
      "not-editable",
    );
    expect(matchElement(element({ label: "City", readonly: true }), facts()).refusal).toBe(
      "not-editable",
    );
  });
});

describe("the apply form", () => {
  test("only fields backed by a fact are matched, and the password never is", () => {
    const matches = matchElements(applyFormElements(), facts());
    const matched = matches.filter((match) => match.status === "matched");
    expect(matched.map((match) => match.field).sort()).toEqual(["city", "email"]);
    const password = matches.find((match) => match.ref.ref === elementRefId("e-password"));
    expect(password?.status).toBe("refused");
  });

  test("every match carries a confidence and a reason a person can read", () => {
    for (const match of matchElements(applyFormElements(), facts())) {
      expect(match.reason.length).toBeGreaterThan(0);
      expect(match.confidence).toBeGreaterThanOrEqual(0);
      expect(match.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("a dropdown is a presentation choice, not a different field", () => {
  const control = (label: string, inputType: string) =>
    element({
      ref: elementRefId(`e${label.replace(/[^a-z]/gi, "")}`),
      label,
      inputType,
      role: "combobox",
    });
  const recognize = (label: string, inputType = "select-one") =>
    matchElements([control(label, inputType)], facts())[0];

  // The live failure this exists for: every real application form renders Country as
  // a select, and the select penalty put it under the recognition threshold, so the
  // control could never be filled from a profile at all.
  test("a select is recognized as the field its label names", () => {
    for (const [label, field] of [
      ["Country *", "country"],
      ["City", "city"],
      ["Notice period", "notice_period"],
    ] as const) {
      const match = recognize(label);
      expect({
        label,
        field: match?.field,
        unrecognized: match?.status === "unrecognized",
      }).toEqual({ label, field, unrecognized: false });
    }
  });

  // The penalty still has to do its job where the type really does disagree.
  test("a date input labelled Email is still penalized below the threshold", () => {
    const match = recognize("Email address", "date");
    expect(match?.status).toBe("unrecognized");
  });
});
