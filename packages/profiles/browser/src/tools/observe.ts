import type { ToolResult } from "@mu/core";
import { tool } from "mu";
import { z } from "zod";
import { hostOf } from "../actions/navigate.ts";
import { Stopwatch } from "../actions/types.ts";
import { INJECTION_NOTE, looksLikeInjection } from "../page/injection.ts";
import { pageFacts, renderHeader } from "../page/observe.ts";
import { describeNode, fencePageContent } from "../page/render.ts";
import { resolveRef } from "../page/resolve.ts";
import { captureScreenshot, screenshotHeader } from "../page/screenshot.ts";
import { capturePage } from "../page/snapshot.ts";
import { filterSections, findNodes, pageMarkdown, paginate } from "../page/text.ts";
import { type BrowserToolDeps, pageAction } from "./shared.ts";

const observeScope = () => "browser:observe";

function activeHost(deps: BrowserToolDeps): string {
  return hostOf(deps.browser.tabs().find((tab) => tab.active)?.url ?? "") || "*";
}

export function snapshotTool(deps: BrowserToolDeps) {
  return tool({
    name: "snapshot",
    description:
      "Re-observe the active page. Every action already returns the new page state, so use this only to refresh after waiting, to see the whole page (scope: full), or to expand one element's subtree (ref).",
    inputSchema: z.object({
      scope: z.enum(["viewport", "full"]).optional().describe("viewport (default) or full page"),
      ref: z.string().optional().describe("Show only this element's subtree"),
    }),
    executionMode: "sequential",
    changesState: false,
    permissionScope: observeScope,
    permissionPattern: () => activeHost(deps),
    execute: ({ scope, ref }, { signal }) =>
      pageAction(
        deps,
        signal,
        async () => ({ summary: ref ? `snapshot of ${ref}` : `snapshot (${scope ?? "viewport"})` }),
        {
          blockedByDialog: false,
          screenshot: false,
          ...(scope ? { scope } : {}),
          ...(ref ? { subtreeRef: ref } : {}),
        },
      ),
  });
}

export function screenshotTool(deps: BrowserToolDeps) {
  return tool({
    name: "screenshot",
    description:
      "Look at the page as an image (viewport by default, one element with ref, or the full page). Use it to check visual state the text snapshot cannot show: layout, icons, canvas, images, colors.",
    inputSchema: z.object({
      ref: z.string().optional().describe("Capture only this element"),
      fullPage: z.boolean().optional().describe("Capture the whole scrollable page"),
    }),
    executionMode: "sequential",
    changesState: false,
    permissionScope: observeScope,
    permissionPattern: () => activeHost(deps),
    execute: async ({ ref, fullPage }, { signal }): Promise<ToolResult> => {
      if (!deps.vision()) {
        return {
          content: [
            {
              type: "text",
              text: "Screenshots are off for this model (it cannot read images, or vision is set to off). Use snapshot, read_page or find instead.",
            },
          ],
          isError: true,
        };
      }
      const actionSignal = deps.browser.actionSignal(signal);
      const stopwatch = new Stopwatch();
      const tab = await stopwatch.time("cdpMs", () => deps.browser.activeTab(actionSignal));
      if (tab.dialog) {
        return {
          content: [
            {
              type: "text",
              text: "A JavaScript dialog blocks the page; handle it with the dialog tool first.",
            },
          ],
          isError: true,
        };
      }
      let box: { x: number; y: number; w: number; h: number } | undefined;
      if (ref) {
        const resolved = await resolveRef(tab, ref, actionSignal);
        await resolved.session.send(
          "DOM.scrollIntoViewIfNeeded",
          { backendNodeId: resolved.backendNodeId },
          { signal: actionSignal },
        );
        const model = await capturePage(tab, { scope: "full", signal: actionSignal });
        const stack = [model.root];
        while (stack.length > 0) {
          const node = stack.pop();
          if (!node) break;
          if (node.ref === ref) {
            box = node.box;
            break;
          }
          stack.push(...node.children);
        }
        if (!box) throw new Error(`ref ${ref} has no visible box`);
      }
      const shot = await stopwatch.time("screenshotMs", () =>
        captureScreenshot(tab, { signal: actionSignal, box, fullPage }),
      );
      const header = renderHeader(
        { url: tab.url },
        { count: deps.browser.tabs().length, active: tab.tabId },
        tab.dialog,
      );
      const summary = `screenshot of ${ref ?? (fullPage ? "the full page" : "the viewport")}`;
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n${header}\n${screenshotHeader(shot)}\n${fencePageContent(pageFacts(tab.title))}`,
          },
          { type: "image", mimeType: shot.mimeType, data: shot.data },
        ],
        details: { timings: stopwatch.finish(), url: tab.url, title: tab.title, tabId: tab.tabId },
        retention: { key: "browser:screenshot", summary },
      };
    },
  });
}

export function readPageTool(deps: BrowserToolDeps) {
  return tool({
    name: "read_page",
    description:
      "Read the page's main content as compact markdown (headings, text, lists, tables, links with refs), without scrolling. Pass query to keep only sections mentioning it; pass offset to continue a long page. Copy anything you need to keep into notes: older read_page output is collapsed later.",
    inputSchema: z.object({
      query: z.string().optional().describe("Keep only sections mentioning these words"),
      offset: z.number().int().min(0).optional().describe("Character offset to continue from"),
    }),
    executionMode: "sequential",
    changesState: false,
    permissionScope: observeScope,
    permissionPattern: () => activeHost(deps),
    execute: async ({ query, offset }, { signal }): Promise<ToolResult> => {
      const actionSignal = deps.browser.actionSignal(signal);
      const stopwatch = new Stopwatch();
      const tab = await stopwatch.time("cdpMs", () => deps.browser.activeTab(actionSignal));
      if (tab.dialog) {
        return {
          content: [
            {
              type: "text",
              text: "A JavaScript dialog blocks the page; handle it with the dialog tool first.",
            },
          ],
          isError: true,
        };
      }
      const model = await stopwatch.time("snapshotMs", () =>
        capturePage(tab, { scope: "full", signal: actionSignal, maxText: 20_000 }),
      );
      for (const secret of model.secrets) deps.browser.secrets.add(secret);
      const { markdown, scope } = pageMarkdown(model);
      const filtered = query ? filterSections(markdown, query) : markdown;
      const page = paginate(filtered, offset ?? 0);
      const more =
        page.end < page.total
          ? `\n(showing characters ${page.start}–${page.end} of ${page.total}; call read_page with offset=${page.end}${query ? ` and the same query` : ""} for more)`
          : page.start > 0
            ? `\n(end of content; characters ${page.start}–${page.end} of ${page.total})`
            : "";
      const body = query && !filtered ? `(no section mentions "${query}")` : page.chunk;
      const summary = `read_page ${query ? `query "${query}" ` : ""}chars ${page.start}–${page.end} of ${page.total}`;
      const text = [
        summary,
        ...(looksLikeInjection(body) ? [INJECTION_NOTE] : []),
        `[page] url: ${model.url}\nreading: ${scope}`,
        `${fencePageContent([...pageFacts(model.title), body])}${more}`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          timings: stopwatch.finish(),
          url: model.url,
          title: model.title,
          tabId: tab.tabId,
        },
        retention: {
          key: "browser:read_page",
          summary: `${summary} (content collapsed; keep data in notes)`,
        },
      };
    },
  });
}

export function findTool(deps: BrowserToolDeps) {
  return tool({
    name: "find",
    description:
      "Search the whole page (not just the visible part) for elements whose text, name or value matches, and get their refs and where they are. Faster than scrolling to look for something.",
    inputSchema: z
      .object({
        text: z.string().min(1).optional().describe("Case-insensitive text to look for"),
        regex: z
          .string()
          .min(1)
          .optional()
          .describe("JavaScript regular expression (case-insensitive)"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum matches (default 20)"),
      })
      .refine((args) => args.text !== undefined || args.regex !== undefined, {
        message: "pass text or regex",
      }),
    executionMode: "sequential",
    changesState: false,
    permissionScope: observeScope,
    permissionPattern: () => activeHost(deps),
    execute: async ({ text, regex, limit }, { signal }): Promise<ToolResult> => {
      let matcher: (value: string) => boolean;
      if (regex !== undefined) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(regex, "i");
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid regex: ${error instanceof Error ? error.message : error}`,
              },
            ],
            isError: true,
          };
        }
        matcher = (value) => pattern.test(value);
      } else {
        const needle = (text as string).toLowerCase();
        matcher = (value) => value.toLowerCase().includes(needle);
      }
      const actionSignal = deps.browser.actionSignal(signal);
      const stopwatch = new Stopwatch();
      const tab = await stopwatch.time("cdpMs", () => deps.browser.activeTab(actionSignal));
      if (tab.dialog) {
        return {
          content: [
            {
              type: "text",
              text: "A JavaScript dialog blocks the page; handle it with the dialog tool first.",
            },
          ],
          isError: true,
        };
      }
      const model = await stopwatch.time("snapshotMs", () =>
        capturePage(tab, { scope: "full", signal: actionSignal }),
      );
      for (const secret of model.secrets) deps.browser.secrets.add(secret);
      const { matches, total } = findNodes(model, matcher, limit ?? 20);
      const label = regex !== undefined ? `/${regex}/i` : JSON.stringify(text);
      const lines = matches.map(
        (match) =>
          `- ${describeNode(match.node, model.url)} (${match.position}${match.context ? `; in ${match.context}` : ""})`,
      );
      const summary = `find ${label}: ${total} match${total === 1 ? "" : "es"}`;
      const body =
        lines.length === 0
          ? "(no matches)"
          : `${lines.join("\n")}${total > matches.length ? `\n… (${total - matches.length} more; narrow the search or raise limit)` : ""}`;
      return {
        content: [
          {
            type: "text",
            text: `${summary}\n[page] url: ${model.url}\n${fencePageContent([...pageFacts(model.title), body])}`,
          },
        ],
        details: {
          timings: stopwatch.finish(),
          url: model.url,
          title: model.title,
          tabId: tab.tabId,
          total,
        },
        retention: { key: "browser:find", summary },
      };
    },
  });
}
