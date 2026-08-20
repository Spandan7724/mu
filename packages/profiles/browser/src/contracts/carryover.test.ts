import { describe, expect, test } from "bun:test";
import { sampleCarryover, sampleTakeoverState } from "../testing/samples.ts";
import { browserCarryoverSchema } from "./carryover.ts";
import { assertJsonSerializable } from "./json.ts";
import { BrowserSecret } from "./secret.ts";
import { suppressesScreenshots, takeoverStateSchema } from "./takeover.ts";

function rejects(carryover: unknown): boolean {
  return !browserCarryoverSchema.safeParse(carryover).success;
}

describe("carryover", () => {
  test("accepts the sample carryover and stays plain JSON", () => {
    const carryover = sampleCarryover();
    expect(browserCarryoverSchema.safeParse(carryover).success).toBe(true);
    assertJsonSerializable(carryover, "carryover");
  });

  test("survives a takeover being in progress", () => {
    const carryover = sampleCarryover({ takeover: sampleTakeoverState() });
    expect(browserCarryoverSchema.safeParse(carryover).success).toBe(true);
    assertJsonSerializable(carryover, "carryover");
  });

  test("carries field labels and fact ids, never the values that were filled", () => {
    expect(
      rejects(
        sampleCarryover({
          filledFields: [
            { label: "Full name", origin: "https://jobs.example.com", value: "Ada" } as never,
          ],
        }),
      ),
    ).toBe(true);
  });

  test("an unknown key cannot ride through compaction", () => {
    expect(rejects({ ...sampleCarryover(), extensionToken: "mu_ext_1" })).toBe(true);
  });

  test("a secret cannot be smuggled into a carried value", () => {
    const carryover = { ...sampleCarryover(), receiptId: new BrowserSecret("mu_ext_1") };
    expect(rejects(carryover)).toBe(true);
    expect(() => assertJsonSerializable(carryover, "carryover")).toThrow();
  });

  test("allowed origins must be normalized origins", () => {
    expect(rejects(sampleCarryover({ allowedOrigins: ["https://jobs.example.com/apply"] }))).toBe(
      true,
    );
  });

  test("the connection summary carries no connection id or token", () => {
    const keys = Object.keys(sampleCarryover().connection).sort();
    expect(keys).toEqual(["browser", "mode", "phase"]);
  });
});

describe("takeover state", () => {
  test("has no field a credential could live in", () => {
    expect(takeoverStateSchema.safeParse(sampleTakeoverState()).success).toBe(true);
    expect(
      takeoverStateSchema.safeParse({ ...sampleTakeoverState(), password: "hunter2" }).success,
    ).toBe(false);
  });

  test("instructions are required so the user knows what to do", () => {
    expect(takeoverStateSchema.safeParse(sampleTakeoverState({ instructions: "" })).success).toBe(
      false,
    );
  });

  test("credential reasons suppress screenshots", () => {
    for (const reason of ["login", "password", "passkey", "mfa", "captcha"] as const) {
      expect(suppressesScreenshots(reason)).toBe(true);
    }
    for (const reason of ["ambiguous-action", "unsupported-ui", "user-requested"] as const) {
      expect(suppressesScreenshots(reason)).toBe(false);
    }
  });
});
