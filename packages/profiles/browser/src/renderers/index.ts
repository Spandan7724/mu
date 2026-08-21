// Profile-owned tool cells, written against `ToolRenderer` from the kernel rather
// than the TUI's line API, so the browser profile keeps its dependency direction
// (profile → sdk → core) and never imports the terminal renderer.
import type { ToolRenderer } from "@mu/core";
import { BROWSER_STATUS_TOOL } from "../profile/tools.ts";

function resultText(result: Parameters<ToolRenderer["render"]>[0]["result"]): string {
  return (result?.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

const statusRenderer: ToolRenderer = {
  render: (info) => {
    const text = resultText(info.result);
    if (text.length === 0) return ["browser · checking the connection"];
    const [headline, ...rest] = text.split("\n");
    return [`browser · ${headline}`, ...rest.map((line) => `  ${line}`)];
  },
};

export const browserRenderers: Record<string, ToolRenderer> = {
  [BROWSER_STATUS_TOOL]: statusRenderer,
};
