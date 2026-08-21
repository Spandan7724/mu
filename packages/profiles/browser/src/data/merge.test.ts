import { describe, expect, test } from "bun:test";
import {
  conflictedFields,
  type LayeredFact,
  mergeFacts,
  resolutionsByField,
  resolvedFacts,
} from "./merge.ts";
import { fact } from "./samples.ts";

function layer(
  layerName: LayeredFact["layer"],
  id: string,
  field: string,
  value: string,
  updatedAt = 1,
): LayeredFact {
  return { layer: layerName, fact: fact({ id, field, value, updatedAt }) };
}

describe("merge precedence", () => {
  test("an explicit answer beats the saved profile, which beats a document", () => {
    const resolutions = mergeFacts([
      layer("document", "f-doc", "city", "Shelbyville"),
      layer("profile", "f-profile", "city", "Ogdenville"),
      layer("answer", "f-answer", "city", "Springfield"),
    ]);
    const city = resolutionsByField(resolutions).get("city");
    expect(city?.status).toBe("override");
    expect(city?.winner?.id).toBe("f-answer");
    expect(city?.superseded.map((entry) => entry.fact.id)).toEqual(["f-doc", "f-profile"]);
  });

  test("a single source is a unique resolution, not an override", () => {
    const [resolution] = mergeFacts([layer("document", "f-doc", "email", "a@example.invalid")]);
    expect(resolution?.status).toBe("unique");
    expect(resolution?.winner?.id).toBe("f-doc");
    expect(resolution?.superseded).toHaveLength(0);
  });

  test("agreeing layers do not count as supersession", () => {
    const [resolution] = mergeFacts([
      layer("document", "f-doc", "city", "springfield"),
      layer("profile", "f-profile", "city", "Springfield "),
    ]);
    expect(resolution?.status).toBe("unique");
    expect(resolution?.superseded).toHaveLength(0);
  });
});

describe("conflict representation", () => {
  test("two sources in the same layer disagreeing produce no winner", () => {
    const resolutions = mergeFacts([
      layer("profile", "f-a", "email", "ada@example.invalid"),
      layer("profile", "f-b", "email", "testwell@example.invalid", 99),
    ]);
    const [resolution] = resolutions;
    expect(resolution?.status).toBe("conflict");
    expect(resolution?.winner).toBeUndefined();
    expect(resolution?.disagreeing).toHaveLength(2);
    expect(conflictedFields(resolutions)).toHaveLength(1);
  });

  test("a conflict is never resolved by taking the newest value", () => {
    const [resolution] = mergeFacts([
      layer("answer", "f-old", "desired_salary", "120000", 1),
      layer("answer", "f-new", "desired_salary", "150000", 2),
    ]);
    expect(resolution?.status).toBe("conflict");
    expect(resolvedFacts([resolution as NonNullable<typeof resolution>])).toHaveLength(0);
  });

  test("a sensitive conflict is described without printing either value", () => {
    const [resolution] = mergeFacts([
      layer("profile", "f-a", "desired_salary", "120000"),
      layer("profile", "f-b", "desired_salary", "150000"),
    ]);
    expect(resolution?.reason).not.toContain("120000");
    expect(resolution?.reason).not.toContain("150000");
    expect(resolution?.reason).toContain("has one value");
  });

  test("a non-sensitive conflict names the values so the user can choose", () => {
    const [resolution] = mergeFacts([
      layer("profile", "f-a", "city", "Springfield"),
      layer("profile", "f-b", "city", "Shelbyville"),
    ]);
    expect(resolution?.reason).toContain("Springfield");
    expect(resolution?.reason).toContain("Shelbyville");
  });

  test("a lower layer disagreeing with a winning answer is recorded, not dropped", () => {
    const [resolution] = mergeFacts([
      layer("document", "f-doc", "email", "old@example.invalid"),
      layer("answer", "f-answer", "email", "ada.testwell@example.invalid"),
    ]);
    expect(resolution?.status).toBe("override");
    expect(resolution?.superseded[0]?.fact.id).toBe("f-doc");
    expect(resolution?.reason).toContain("old@example.invalid");
  });
});

describe("resolved view", () => {
  test("only fields with a winner reach the resolved set", () => {
    const resolutions = mergeFacts([
      layer("answer", "f-city", "city", "Springfield"),
      layer("profile", "f-a", "email", "a@example.invalid"),
      layer("profile", "f-b", "email", "b@example.invalid"),
    ]);
    expect(resolvedFacts(resolutions).map((entry) => entry.field)).toEqual(["city"]);
  });
});
