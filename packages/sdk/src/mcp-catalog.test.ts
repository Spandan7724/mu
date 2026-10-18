import { describe, expect, test } from "bun:test";
import {
  type CatalogTool,
  describeText,
  isLargeServer,
  listingLine,
  openText,
  type ServerCatalog,
  signature,
  validateArgs,
} from "./mcp-catalog.ts";

const merge: CatalogTool = {
  name: "merge_pull_request",
  description: "Merge a pull request in a GitHub repository. Extra detail.",
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      pullNumber: { type: "number" },
      merge_method: { type: "string", enum: ["merge", "squash", "rebase"] },
      labels: { type: "array", items: { type: "string" } },
      fields: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    },
    required: ["owner", "repo", "pullNumber"],
  },
};

function catalog(tools: CatalogTool[], extra: Partial<ServerCatalog> = {}): ServerCatalog {
  return { tools, resources: false, fetchedAt: 0, ...extra };
}

describe("signatures", () => {
  test("required parameters first, enums as unions, nested objects inline", () => {
    expect(signature(merge)).toBe(
      'merge_pull_request(owner: string, repo: string, pullNumber: number, merge_method?: "merge"|"squash"|"rebase", labels?: string[], fields?: {name: string}[]) — Merge a pull request in a GitHub repository.',
    );
  });

  test("small servers open with signatures; large ones open as a name index", () => {
    const small = openText("gh", catalog([merge], { instructions: "Use carefully." }));
    expect(small).toContain("Instructions:\nUse carefully.");
    expect(small).toContain("merge_pull_request(owner: string");

    const many = Array.from({ length: 60 }, (_, i) => ({ ...merge, name: `tool_${i}` }));
    const big = catalog(many, { instructions: "x".repeat(5000) });
    expect(isLargeServer(big)).toBe(true);
    const index = openText("gh", big);
    expect(index).toContain("Tools: tool_0, tool_1");
    expect(index).not.toContain("tool_0(");
    expect(index).toContain("mcp_describe");
    expect(index.length).toBeLessThan(2500);
    expect(describeText("gh", big, ["tool_3", "missing"])).toBe(
      `${signature({ ...merge, name: "tool_3" })}\nmissing: no such tool on gh`,
    );
  });

  test("the listing line names tools or says the server is not connected yet", () => {
    expect(listingLine("gh", { catalog: catalog([merge]) })).toBe(
      "- gh: Tools: merge_pull_request",
    );
    expect(listingLine("gh", { description: "GitHub. Issues and PRs." })).toBe(
      "- gh: GitHub. (not connected yet; mcp_open connects it)",
    );
  });
});

describe("argument validation", () => {
  test("reports missing, mistyped and out-of-enum arguments, including nested ones", () => {
    expect(validateArgs({ owner: "a", repo: "b", pullNumber: 1 }, merge.inputSchema)).toEqual([]);
    expect(
      validateArgs(
        { owner: "a", pullNumber: "1", merge_method: "fast", fields: [{}] },
        merge.inputSchema,
      ),
    ).toEqual([
      "arguments.repo is required",
      "arguments.pullNumber must be number",
      'arguments.merge_method must be one of "merge", "squash", "rebase"',
      "arguments.fields[0].name is required",
    ]);
  });
});
