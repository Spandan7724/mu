import { describe, expect, test } from "bun:test";
import { stringWidth, stripAnsi } from "@mu/tui";
import type { CostReport, Usage } from "mu";
import { renderCostCommand } from "./cost-command.ts";

const usage = (input: number, cacheRead: number, output: number, cost: number): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  costUsd: cost,
});

const sum = (values: Usage[]): Usage =>
  values.reduce(
    (a, b) => ({
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
    }),
    usage(0, 0, 0, 0),
  );

const main = usage(301_904, 2_610_880, 39_880, 3.7704);
const side = usage(18_330, 54_100, 1_104, 0.0407);
const sub = usage(96_120, 281_004, 7_402, 0.9944);

const report = (overrides: Partial<CostReport> = {}): CostReport => ({
  kind: "cost",
  totals: sum([main, side, sub]),
  lines: [
    { source: "main", model: "anthropic/claude-opus-5-5", usage: main, turns: 41 },
    { source: "subagents", model: "anthropic/claude-opus-5-5", usage: sub, turns: 17 },
    { source: "side", model: "openai/gpt-5.6-sol", usage: side, turns: 3 },
  ],
  context: {
    tokens: 61_204,
    window: 200_000,
    reported: true,
    autoCompactAt: 0.85,
    parts: [
      { id: "system", label: "system prompt", tokens: 2_927 },
      { id: "tools", label: "tool definitions", tokens: 6_766, count: 14 },
      { id: "context", label: "instructions", tokens: 3_383 },
      {
        id: "messages",
        label: "messages",
        tokens: 13_097,
        children: [
          { id: "user", tokens: 2_282 },
          { id: "assistant", tokens: 10_815 },
        ],
      },
      {
        id: "toolResults",
        label: "tool results",
        tokens: 35_031,
        children: [
          { id: "read", tokens: 20_000 },
          { id: "bash", tokens: 9_000 },
          { id: "grep", tokens: 4_000 },
          { id: "edit", tokens: 1_031 },
          { id: "glob", tokens: 1_000 },
        ],
      },
    ],
  },
  ...overrides,
});

const plain = (lines: string[]) => lines.map(stripAnsi);

describe("renderCostCommand", () => {
  test("shows spend by source and model, then what fills the context", () => {
    const lines = plain(renderCostCommand(report(), 80, "none"));
    expect(lines).toContain("  Session cost · $4.8055");
    expect(lines).toContain(
      "    side (/btw)    18,330       54,100             0    1,104   $0.0407",
    );
    expect(
      lines.some((line) => line.startsWith("    anthropic/claude-opus-5-5   $4.7648 · 58 turns")),
    ).toBe(true);
    expect(lines).toContain(
      "  Context · 61,204 / 200,000 (30.6%) · 108,796 until auto-compact at 85%",
    );
    expect(lines).toContain("  tool definitions  ≈   6,766    3.4% · 14 tools");
    expect(lines).toContain(
      "  tool results      ≈  35,031   17.5% · read 20,000 · bash 9,000 · +2 more",
    );
    expect(lines).toContain("  messages          ≈  13,097    6.5% · you 2,282 · mu 10,815");
    expect(lines).toContain("  free                138,796   69.4%");
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(80);
  });

  test("one source and one model need no breakdown rows", () => {
    const lines = plain(
      renderCostCommand(
        report({
          totals: main,
          lines: [{ source: "main", model: "a/b", usage: main, turns: 4 }],
        }),
        80,
        "none",
      ),
    );
    expect(lines.some((line) => line.includes("main turns"))).toBe(false);
    expect(lines).not.toContain("  by model");
  });

  test("an unreported context total is marked as an estimate", () => {
    const base = report();
    const lines = plain(
      renderCostCommand(report({ context: { ...base.context, reported: false } }), 80, "none"),
    );
    expect(lines.some((line) => line.startsWith("  Context · ≈ 61,204 / 200,000"))).toBe(true);
  });

  test("colour adds the bar and swatches; without colour neither is drawn", () => {
    const colored = plain(renderCostCommand(report(), 80, "truecolor"));
    expect(colored.some((line) => line.includes("━") && line.includes("┃"))).toBe(true);
    expect(colored.some((line) => line.startsWith("  ■ system prompt"))).toBe(true);
    const bare = plain(renderCostCommand(report(), 80, "none"));
    expect(bare.some((line) => line.includes("━") || line.includes("■"))).toBe(false);
  });
});
