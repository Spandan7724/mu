// The fake driver's fixture is declared without importing the conformance
// harness, so the published declaration bundle need not carry test scaffolding.
// This is the check that the two shapes have not drifted apart since.
import { describe, expect, test } from "bun:test";
import type { DriverCapability, DriverContractFixture } from "../../testing/conformance-types.ts";
import { FAKE_DRIVER_CAPABILITIES, FAKE_DRIVER_FIXTURE } from "./fixture.ts";

const fixture: DriverContractFixture = FAKE_DRIVER_FIXTURE;
const capabilities: Readonly<Record<DriverCapability, boolean>> = FAKE_DRIVER_CAPABILITIES;

describe("the fake fixture still satisfies the conformance harness's own types", () => {
  test("every page, label and value the harness needs is present", () => {
    for (const url of Object.values(fixture.pages)) expect(url.startsWith("https://")).toBe(true);
    for (const label of Object.values(fixture.labels)) expect(label.length).toBeGreaterThan(0);
    for (const value of Object.values(fixture.values)) expect(value.length).toBeGreaterThan(0);
    expect(fixture.crossOriginFrameOrigin).not.toBe(fixture.origin);
  });

  test("every capability the fake declares is one the harness knows", () => {
    const known: DriverCapability[] = [
      "history",
      "popups",
      "dialogs",
      "fileUpload",
      "downloads",
      "crossOriginFrames",
      "screenshots",
      "crashSimulation",
      "reconnect",
      "submissionLedger",
    ];
    expect(Object.keys(capabilities).sort()).toEqual([...known].sort());
    expect(Object.values(capabilities).every(Boolean)).toBe(true);
  });
});
