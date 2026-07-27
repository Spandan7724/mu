import { describe, expect, test } from "bun:test";
import { agentCell, checkpointCell, diffCell, errorCell, toolCell, userCell } from "./cells.ts";
import { approvalOverlay, SelectList } from "./components.ts";
import { InputDecoder } from "./input.ts";
import { sanitizeTerminalText, sanitizeUntrusted } from "./sanitize.ts";

const ESC = "\u001b";
const BEL = "\u0007";
const ctx = { width: 60, depth: "none" as const };

// Anything that reaches the terminal from untrusted content must not be able
// to drive it.
function assertNoControls(text: string): void {
  expect(text).not.toContain(ESC);
  expect(text).not.toContain(BEL);
  expect(text).not.toContain("\u001b]");
}

describe("sanitizeUntrusted", () => {
  test("strips OSC 52 clipboard writes", () => {
    const attack = `before${ESC}]52;c;dGVzdA==${BEL}after`;
    const clean = sanitizeUntrusted(attack);
    expect(clean).toBe("beforeafter");
    assertNoControls(clean);
  });

  test("strips OSC 8 deceptive hyperlinks", () => {
    const attack = `${ESC}]8;;https://evil.example${BEL}click me${ESC}]8;;${BEL}`;
    const clean = sanitizeUntrusted(attack);
    expect(clean).toBe("click me");
    assertNoControls(clean);
  });

  test("strips OSC terminated by ST rather than BEL", () => {
    const clean = sanitizeUntrusted(`x${ESC}]0;new title${ESC}\\y`);
    expect(clean).toBe("xy");
    assertNoControls(clean);
  });

  test("strips cursor movement and clear-screen", () => {
    const clean = sanitizeUntrusted(`a${ESC}[2J${ESC}[H${ESC}[10Ab`);
    expect(clean).toBe("ab");
    assertNoControls(clean);
  });

  test("strips DCS and APC payloads", () => {
    assertNoControls(sanitizeUntrusted(`a${ESC}Ppayload${ESC}\\b`));
    assertNoControls(sanitizeUntrusted(`a${ESC}_payload${ESC}\\b`));
  });

  test("strips carriage returns that would overwrite the line", () => {
    expect(sanitizeUntrusted("real output\rFAKE")).toBe("real outputFAKE");
  });

  test("keeps newlines and tabs", () => {
    expect(sanitizeUntrusted("a\nb\tc")).toBe("a\nb\tc");
  });

  test("drops a lone or malformed trailing escape", () => {
    assertNoControls(sanitizeUntrusted(`text${ESC}`));
    assertNoControls(sanitizeUntrusted(`text${ESC}[`));
  });

  test("strips SGR from untrusted text but can keep it for our own", () => {
    const styled = `${ESC}[31mred${ESC}[0m`;
    expect(sanitizeUntrusted(styled)).toBe("red");
    expect(sanitizeTerminalText(styled, { allowStyling: true })).toBe(styled);
  });

  test("a non-SGR CSI is dropped even when styling is allowed", () => {
    expect(sanitizeTerminalText(`${ESC}[2Jx`, { allowStyling: true })).toBe("x");
  });

  test("plain text is untouched", () => {
    expect(sanitizeUntrusted("ordinary text with émoji 🎉")).toBe("ordinary text with émoji 🎉");
  });
});

describe("untrusted content at every render boundary", () => {
  const attack = `pwn${ESC}]52;c;dGVzdA==${BEL}${ESC}[2J`;

  test("agent text", () => assertNoControls(agentCell(attack, ctx).join("\n")));
  test("user text", () => assertNoControls(userCell(attack, ctx).join("\n")));
  test("error text", () => assertNoControls(errorCell(attack, ctx).join("\n")));

  test("tool name, argument and summary", () => {
    const lines = toolCell(
      { name: "bash", primaryArg: attack, summary: attack, tail: [attack] },
      ctx,
    );
    assertNoControls(lines.join("\n"));
  });

  test("diff paths and content", () => {
    const lines = diffCell(
      {
        path: attack,
        added: 1,
        removed: 0,
        lines: [{ kind: "add", lineNumber: 1, text: attack }],
      },
      ctx,
    );
    assertNoControls(lines.join("\n"));
  });

  test("checkpoint paths", () => {
    const lines = checkpointCell(
      {
        action: "undo",
        files: [{ path: attack, added: 1, removed: 0, hunks: [] }],
        messageCount: 2,
      },
      ctx,
    );
    assertNoControls(lines.join("\n"));
  });

  test("approval preview — the command being approved", () => {
    const lines = approvalOverlay(
      { title: attack, preview: [attack], selectedIndex: 0 },
      60,
      "none",
    );
    assertNoControls(lines.join("\n"));
  });

  test("selection list labels and descriptions", () => {
    const list = new SelectList([{ label: attack, description: attack }]);
    assertNoControls(list.render(60, "none").join("\n"));
  });
});

describe("bracketed paste terminator split across reads", () => {
  test("a terminator split at every byte boundary still completes", () => {
    const END = `${ESC}[201~`;
    for (let split = 1; split < END.length; split++) {
      const decoder = new InputDecoder();
      decoder.push(`${ESC}[200~payload${END.slice(0, split)}`);
      const events = decoder.push(END.slice(split));

      const paste = events.find((e) => e.type === "paste");
      expect(paste?.type === "paste" && paste.text).toBe("payload");
    }
  });

  test("one byte at a time still completes and input keeps working", () => {
    const decoder = new InputDecoder();
    const stream = `${ESC}[200~hello${ESC}[201~x`;
    const events = stream.split("").flatMap((byte) => decoder.push(byte));

    const paste = events.find((e) => e.type === "paste");
    expect(paste?.type === "paste" && paste.text).toBe("hello");
    // The decoder left paste mode: the following key still decodes.
    expect(events.some((e) => e.type === "key" && e.key.name === "x")).toBe(true);
  });

  test("marker-like text inside a payload is preserved", () => {
    const decoder = new InputDecoder();
    const events = decoder.push(`${ESC}[200~literal [201~ text${ESC}[201~`);
    const paste = events.find((e) => e.type === "paste");
    expect(paste?.type === "paste" && paste.text).toBe("literal [201~ text");
  });
});
