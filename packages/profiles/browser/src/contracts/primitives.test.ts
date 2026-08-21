import { describe, expect, test } from "bun:test";
import { artifactRelativePathSchema } from "./primitives.ts";

describe("artifactRelativePathSchema", () => {
  test("accepts paths under the artifact root", () => {
    for (const value of ["shot.png", "sess-1/shot.png", "a/b/c/receipt.json"]) {
      expect(artifactRelativePathSchema.safeParse(value).success).toBe(true);
    }
  });

  // SECURITY.md §11 forbids raw base64 screenshots in persisted artifacts. A `data:`
  // URI has more than one letter before its colon, so a Windows-drive check alone
  // let it through a path field.
  test("rejects scheme-shaped values that could smuggle inline content", () => {
    for (const value of [
      "data:image/png;base64,iVBORw0KGgo=",
      "http://example.com/shot.png",
      "https://example.com/shot.png",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "C:/Windows/system32",
    ]) {
      expect(artifactRelativePathSchema.safeParse(value).success).toBe(false);
    }
  });

  test("rejects escapes out of the artifact root", () => {
    for (const value of ["/etc/passwd", "../secret", "a/../../secret", "~/secret", ""]) {
      expect(artifactRelativePathSchema.safeParse(value).success).toBe(false);
    }
  });

  test("rejects control characters", () => {
    expect(artifactRelativePathSchema.safeParse("shot\u0000.png").success).toBe(false);
    expect(artifactRelativePathSchema.safeParse("shot\u001f.png").success).toBe(false);
    expect(artifactRelativePathSchema.safeParse("shot\u007f.png").success).toBe(false);
  });
});
