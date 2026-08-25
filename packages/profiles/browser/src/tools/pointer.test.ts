import { describe, expect, test } from "bun:test";
import { FAKE_ORIGIN, fakeSite } from "../drivers/fake/site.ts";
import { createHarness, resultText } from "./harness.ts";
import { browserPointerTool } from "./pointer.ts";

const signal = () => new AbortController().signal;

describe("browser_pointer", () => {
  test("requires the exact current screenshot evidence", async () => {
    const harness = createHarness();
    try {
      const screenshot = await harness.session.observe({ screenshot: "viewport" }, signal());
      const pointer = browserPointerTool({ session: harness.session });
      const completed = await pointer.execute(
        "pointer",
        {
          action: "click",
          x: 10,
          y: 10,
          screenshotRevision: screenshot.revision,
          screenshotEvidenceId: screenshot.evidenceId,
        },
        signal(),
      );
      expect(completed.isError).not.toBe(true);
      expect(resultText(completed)).toContain("Pointer click completed");

      const stale = await pointer.execute(
        "stale",
        {
          action: "click",
          x: 10,
          y: 10,
          screenshotRevision: screenshot.revision,
          screenshotEvidenceId: screenshot.evidenceId,
        },
        signal(),
      );
      expect(stale.isError).toBe(true);
      expect(resultText(stale)).toContain("stale or unavailable");
    } finally {
      await harness.shutdown();
    }
  });

  test("refuses full-page screenshot coordinates because they are not viewport coordinates", async () => {
    const harness = createHarness();
    try {
      const screenshot = await harness.session.observe({ screenshot: "full-page" }, signal());
      const result = await browserPointerTool({ session: harness.session }).execute(
        "pointer",
        {
          action: "click",
          x: 10,
          y: 10,
          screenshotRevision: screenshot.revision,
          screenshotEvidenceId: screenshot.evidenceId,
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('screenshot "viewport"');
    } finally {
      await harness.shutdown();
    }
  });

  test("cannot click through a known commitment region", async () => {
    const url = `${FAKE_ORIGIN}/visual-commitment`;
    const harness = createHarness({
      site: fakeSite(
        [
          {
            url,
            title: "Visual commitment",
            summary: "A page with a known submit region",
            elements: [
              {
                ref: "buy",
                role: "button",
                label: "Buy now",
                risk: ["purchase"],
                box: { x: 20, y: 20, width: 100, height: 40 },
              },
            ],
          },
        ],
        url,
      ),
      allowedOrigins: [FAKE_ORIGIN],
    });
    try {
      const screenshot = await harness.session.observe({ screenshot: "viewport" }, signal());
      const result = await browserPointerTool({ session: harness.session }).execute(
        "pointer",
        {
          action: "click",
          x: 40,
          y: 30,
          screenshotRevision: screenshot.revision,
          screenshotEvidenceId: screenshot.evidenceId,
        },
        signal(),
      );
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("known commitment");
    } finally {
      await harness.shutdown();
    }
  });
});
