import { describe, expect, test } from "bun:test";
import { sampleElement, sampleFrame, sampleObservation, sampleTab } from "../testing/samples.ts";
import { BROWSER_LIMITS } from "./json.ts";
import {
  type BrowserObservation,
  browserElementSchema,
  browserObservationSchema,
  elementRefOf,
  isCredentialElement,
  isRefCurrent,
  refValidity,
  sameElementRef,
} from "./observation.ts";
import { elementRefId } from "./primitives.ts";
import { REDACTED } from "./secret.ts";

function issues(value: unknown): string[] {
  const parsed = browserObservationSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("observation", () => {
  test("accepts the sample observation", () => {
    const parsed: BrowserObservation = browserObservationSchema.parse(sampleObservation());
    expect(parsed.elements).toHaveLength(2);
  });

  test("every element ref must belong to the observed tab", () => {
    const observation = sampleObservation({
      elements: [sampleElement({ tabId: "tab-9" })],
      risks: [],
    });
    expect(issues(observation)).toContain("element refs belong to the observed tab");
  });

  test("every element ref must carry the revision that produced it", () => {
    const observation = sampleObservation({
      elements: [sampleElement({ revision: 1 })],
      risks: [],
    });
    expect(issues(observation)).toContain("element refs carry the revision that produced them");
  });

  test("an element cannot cite a frame the observation did not report", () => {
    const observation = sampleObservation({
      elements: [sampleElement({ frameId: "frame-ghost" })],
      risks: [],
    });
    expect(issues(observation)).toContain("element frame must be one of the observed frames");
  });

  test("duplicate refs are rejected so two elements can never share an identity", () => {
    const observation = sampleObservation({
      elements: [sampleElement(), sampleElement()],
      risks: [],
    });
    expect(issues(observation).join(" ")).toContain("duplicate element ref");
  });

  test("an element risk must also appear in the observation risk summary", () => {
    const observation = sampleObservation({
      elements: [sampleElement({ risk: ["file-upload"] })],
      risks: [],
    });
    expect(issues(observation).join(" ")).toContain("file-upload");
  });

  test("a frame cannot name a parent that was not reported", () => {
    const observation = sampleObservation({
      frames: [sampleFrame({ parentId: "frame-ghost" })],
      elements: [],
      risks: [],
    });
    expect(issues(observation).join(" ")).toContain("unknown parent");
  });

  test("an oversized snapshot is rejected rather than sent to the model", () => {
    const observation = sampleObservation({
      snapshot: "x".repeat(BROWSER_LIMITS.maxSnapshotChars + 1),
    });
    expect(browserObservationSchema.safeParse(observation).success).toBe(false);
  });

  test("an oversized element list is rejected", () => {
    const elements = Array.from({ length: BROWSER_LIMITS.maxElements + 1 }, (_, index) =>
      sampleElement({ ref: elementRefId(`e${index}`) }),
    );
    expect(browserObservationSchema.safeParse(sampleObservation({ elements })).success).toBe(false);
  });

  test("a screenshot must declare itself evictable", () => {
    const observation = sampleObservation({
      screenshot: { mimeType: "image/png", data: "aGk=", evictable: false as never },
    });
    expect(browserObservationSchema.safeParse(observation).success).toBe(false);
  });

  test("a screenshot cannot be both attached and reported omitted", () => {
    const observation = sampleObservation({
      screenshot: { mimeType: "image/png", data: "aGk=", evictable: true },
      screenshotOmitted: "too-large",
    });
    expect(issues(observation)).toContain(
      "an observation cannot attach and omit the same screenshot",
    );
  });

  test("unknown keys are rejected so nothing rides along inside an observation", () => {
    expect(
      browserObservationSchema.safeParse({ ...sampleObservation(), cookies: "session=1" }).success,
    ).toBe(false);
  });
});

describe("credential redaction", () => {
  const cases = [
    { inputType: "password" },
    { label: "Password" },
    { name: "One-time code" },
    { placeholder: "Enter your MFA code" },
    { risk: ["authentication" as const] },
  ];

  test.each(cases)("a credential-shaped element carries no value (%o)", (overrides) => {
    const element = sampleElement({ ...overrides, value: "hunter2" });
    expect(isCredentialElement(element)).toBe(true);
    expect(browserElementSchema.safeParse(element).success).toBe(false);
  });

  test("the redaction marker is the only value a credential field may report", () => {
    const element = sampleElement({ inputType: "password", value: REDACTED });
    expect(browserElementSchema.safeParse(element).success).toBe(true);
  });

  test("a credential field carries no option values either", () => {
    const element = sampleElement({ inputType: "password", options: [{ label: "saved" }] });
    expect(browserElementSchema.safeParse(element).success).toBe(false);
  });

  test("an ordinary field with a password-adjacent word is not mistaken for one", () => {
    const element = sampleElement({ label: "Passport number", value: "X12345" });
    expect(isCredentialElement(element)).toBe(false);
    expect(browserElementSchema.safeParse(element).success).toBe(true);
  });
});

describe("reference validity", () => {
  const observation = sampleObservation();
  const current = elementRefOf(observation.elements[0] as never);

  test("a current reference resolves", () => {
    expect(refValidity(current, observation)).toBe("current");
    expect(isRefCurrent(current, observation)).toBe(true);
  });

  test("a reference from another tab is reported as such, never resolved", () => {
    expect(refValidity({ ...current, tabId: "tab-2" }, observation)).toBe("wrong-tab");
  });

  test("a reference from an older revision is stale", () => {
    expect(refValidity({ ...current, revision: current.revision - 1 }, observation)).toBe(
      "stale-revision",
    );
  });

  test("a reference into a vanished frame is rejected", () => {
    expect(refValidity({ ...current, frameId: "frame-ghost" }, observation)).toBe("unknown-frame");
  });

  test("an invented ref never falls back to an element by position", () => {
    expect(refValidity({ ...current, ref: elementRefId("e99") }, observation)).toBe("unknown");
  });

  test("identity compares ref, tab and revision together", () => {
    expect(sameElementRef(current, { ...current })).toBe(true);
    expect(sameElementRef(current, { ...current, revision: 99 })).toBe(false);
    expect(sameElementRef(current, { ...current, tabId: "tab-2" })).toBe(false);
  });
});

describe("element ref identifiers", () => {
  test("a ref may not be a path, a selector or an empty string", () => {
    for (const value of ["", "../etc/passwd", "#submit > .btn", "javascript:void(0)"]) {
      expect(() => elementRefId(value)).toThrow();
    }
  });

  test("a driver-minted ref round-trips", () => {
    expect(elementRefId("f1e12")).toBe("f1e12" as ReturnType<typeof elementRefId>);
  });

  test("the observed tab is the only tab an observation describes", () => {
    const observation = sampleObservation({ tab: sampleTab({ id: "tab-7" }) });
    expect(issues(observation)).toContain("element refs belong to the observed tab");
  });
});
