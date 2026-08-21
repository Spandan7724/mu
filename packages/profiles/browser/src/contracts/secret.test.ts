import { describe, expect, test } from "bun:test";
import { browserConnectionStateSchema, connectOptionsInputSchema } from "./connection.ts";
import { BrowserSecret, isBrowserSecret, REDACTED } from "./secret.ts";

const TOKEN = "mu_ext_9f3c1a";

describe("browser secret", () => {
  test("reveals its value only through reveal()", () => {
    const secret = new BrowserSecret(TOKEN);
    expect(secret.reveal()).toBe(TOKEN);
    expect(isBrowserSecret(secret)).toBe(true);
  });

  test("stringifies and inspects as a redaction marker", () => {
    const secret = new BrowserSecret(TOKEN);
    expect(String(secret)).toBe(REDACTED);
    expect(`${secret}`).toBe(REDACTED);
    expect(JSON.stringify({ token: secret })).toBe(`{"token":"${REDACTED}"}`);
    expect(JSON.stringify([secret])).toBe(`["${REDACTED}"]`);
  });

  test("has no own property a spread or a key walk could lift the value out of", () => {
    const secret = new BrowserSecret(TOKEN);
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.entries({ ...secret })).toEqual([]);
    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect(JSON.stringify({ ...secret })).toBe("{}");
  });

  test("rejects an empty value", () => {
    expect(() => new BrowserSecret("")).toThrow();
  });

  test("connect options box a configured token so it cannot be serialized raw", () => {
    const parsed = connectOptionsInputSchema.parse({
      mode: "extension",
      browser: "chrome",
      extensionToken: TOKEN,
    });
    expect(isBrowserSecret(parsed.extensionToken)).toBe(true);
    expect(parsed.extensionToken?.reveal()).toBe(TOKEN);
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });

  test("the emitted connection state has no field a token could live in", () => {
    const state = {
      phase: "ready",
      mode: "extension",
      browser: "chrome",
      connectionId: "conn-1",
      updatedAt: 1,
      extensionToken: TOKEN,
    };
    expect(browserConnectionStateSchema.safeParse(state).success).toBe(false);
  });
});
