import { describe, expect, test } from "bun:test";
import { profileTagline } from "./presentation.ts";

describe("profileTagline", () => {
  test("coding keeps the generic banner line", () => {
    expect(profileTagline({ name: "coding" }, { directory: "/tmp" })).toBeUndefined();
  });

  test("browser names the agent, browser, profile and headless mode", () => {
    expect(
      profileTagline(
        { name: "browser" },
        {
          browser: "Google Chrome 154.0.8037.57",
          browserProfile: "work",
          connection: "managed persistent profile",
          headless: "true",
        },
      ),
    ).toBe("browser agent · Google Chrome · profile work · headless");
  });

  test("a cdp connection shows its endpoint and skips an unavailable browser", () => {
    expect(
      profileTagline(
        { name: "browser" },
        {
          browser: "unavailable: no browser found",
          connection: "cdp endpoint http://127.0.0.1:9222",
          headless: "false",
        },
      ),
    ).toBe("browser agent · cdp http://127.0.0.1:9222");
  });
});
