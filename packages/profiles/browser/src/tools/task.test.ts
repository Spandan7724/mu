import { describe, expect, test } from "bun:test";
import { createHarness, resultText } from "./harness.ts";
import { browserTaskTool } from "./task.ts";

const signal = () => new AbortController().signal;

describe("browser_task", () => {
  test("only session-minted evidence can satisfy planned outcomes", async () => {
    const harness = createHarness();
    try {
      await harness.session.beginTask("user-task");
      const task = browserTaskTool({ session: harness.session });
      const planned = await task.execute(
        "plan",
        {
          operation: "plan",
          criteria: [{ id: "page", description: "Read the requested page", kind: "fact" }],
          steps: ["Observe the page", "Ground the answer"],
        },
        signal(),
      );
      expect(resultText(planned)).toContain("Task status: active");

      const invented = await task.execute(
        "bad-evidence",
        { operation: "evidence", criterionId: "page", evidenceId: "made-up" },
        signal(),
      );
      expect(invented.isError).toBe(true);

      const observation = await harness.session.observe({}, signal());
      const attached = await task.execute(
        "evidence",
        {
          operation: "evidence",
          criterionId: "page",
          evidenceId: observation.evidenceId,
        },
        signal(),
      );
      expect(resultText(attached)).toContain("Task status: satisfied");
    } finally {
      await harness.shutdown();
    }
  });
});
