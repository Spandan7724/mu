import { tool } from "mu";
import { z } from "zod";
import {
  type ActionContext,
  clickPoint,
  clickRef,
  dragBetween,
  hoverRef,
} from "../actions/click.ts";
import { handleDialog, uploadFiles } from "../actions/files.ts";
import { fillForm, pressKeys, selectOptions, typeText } from "../actions/input.ts";
import { hostOf } from "../actions/navigate.ts";
import { evaluateScript, MAX_WAIT_SECONDS, waitFor } from "../actions/page.ts";
import { scrollPage } from "../actions/scroll.ts";
import type { Stopwatch } from "../actions/types.ts";
import { formatDownloads } from "../browser/downloads.ts";
import type { Tab } from "../browser/tabs.ts";
import { detailsFor, scopeFor } from "./gate.ts";
import { type ActResult, type BrowserToolDeps, pageAction } from "./shared.ts";

const ref = z.string().min(1).describe("Element ref from the latest page state, e.g. e12 or f1e3");
const commit = z
  .boolean()
  .optional()
  .describe(
    "Set true when this action sends, submits, buys, pays, books, deletes, publishes, posts, transfers, subscribes/unsubscribes, accepts terms or changes account settings",
  );
const reason = z
  .string()
  .optional()
  .describe("Why you are taking this action (shown when asking the user)");
const point = z.object({ x: z.number(), y: z.number() });
const CHANGE = { detectChange: true };

function pageHost(deps: BrowserToolDeps): string {
  return hostOf(deps.browser.tabs().find((tab) => tab.active)?.url ?? "") || "*";
}

function act(deps: BrowserToolDeps, run: (ctx: ActionContext) => Promise<ActResult>) {
  return (tab: Tab, stopwatch: Stopwatch, signal: AbortSignal) =>
    run({ tab, browser: deps.browser, stopwatch, signal });
}

export function interactionTools(deps: BrowserToolDeps) {
  const interact = () => "browser:interact";
  const gated = (toolName: string) => ({
    permissionScope: (args: Record<string, unknown>) => scopeFor(deps, toolName, args),
    permissionDetails: (args: Record<string, unknown>) => detailsFor(deps, toolName, args),
  });
  const host = () => pageHost(deps);
  const common = {
    executionMode: "sequential" as const,
    permissionPattern: host,
  };

  const click = tool({
    name: "click",
    description:
      "Click an element by ref. Reports what changed; if something covers the element you get the covering element instead of a blind click. New tabs opened by the click become active.",
    inputSchema: z.object({
      ref,
      button: z.enum(["left", "right", "middle"]).optional(),
      double: z.boolean().optional().describe("Double-click"),
      modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
      commit,
      reason,
    }),
    ...common,
    ...gated("click"),
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) =>
          clickRef(ctx, args.ref, {
            ...(args.button ? { button: args.button } : {}),
            ...(args.double ? { double: true } : {}),
            ...(args.modifiers ? { modifiers: args.modifiers } : {}),
          }),
        ),
        CHANGE,
      ),
  });

  const type = tool({
    name: "type",
    description:
      "Type text into a text field, search box, textarea or rich editor (replaces its content unless clear is false). Set submit to press Enter afterwards. The resulting value is verified and reported; autocomplete suggestions that appear are marked * in the new page state.",
    inputSchema: z.object({
      ref,
      text: z.string(),
      clear: z.boolean().optional().describe("Replace existing content (default true)"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
      keystrokes: z
        .boolean()
        .optional()
        .describe("Send one key event per character (for fields that ignore pasted text)"),
      commit,
      reason,
    }),
    ...common,
    ...gated("type"),
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) =>
          typeText(ctx, args.ref, args.text, {
            ...(args.clear !== undefined ? { clear: args.clear } : {}),
            ...(args.submit ? { submit: true } : {}),
            ...(args.keystrokes ? { keystrokes: true } : {}),
          }),
        ),
        CHANGE,
      ),
  });

  const fill = tool({
    name: "fill_form",
    description:
      "Fill several fields in one call: text for text fields, true/false for checkboxes, radios and switches, an option label for dropdowns, or a list of labels for multi-selects. Stops at the first field that fails and says how far it got. Optionally click submitRef afterwards.",
    inputSchema: z.object({
      fields: z
        .array(
          z.object({
            ref,
            value: z.union([z.string(), z.boolean(), z.array(z.string())]),
          }),
        )
        .min(1),
      submitRef: z.string().optional().describe("Ref of the button to click after filling"),
      commit,
      reason,
    }),
    ...common,
    ...gated("fill_form"),
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => fillForm(ctx, args.fields, args.submitRef)),
        CHANGE,
      ),
  });

  const select = tool({
    name: "select",
    description:
      "Choose option(s) in a dropdown by visible label (or value): native selects, ARIA listboxes/comboboxes and custom div-based menus (opened and picked for you).",
    inputSchema: z.object({
      ref,
      options: z.array(z.string().min(1)).min(1),
      commit,
      reason,
    }),
    ...common,
    ...gated("select"),
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => selectOptions(ctx, args.ref, args.options)),
        CHANGE,
      ),
  });

  const press = tool({
    name: "press",
    description:
      "Press a key or combination: Enter, Escape, Tab, ArrowDown, PageDown, Backspace, Mod+A (Mod = Cmd on macOS, Ctrl elsewhere), Shift+Tab. Pass ref to focus an element first.",
    inputSchema: z.object({
      keys: z.string().min(1),
      ref: z.string().optional().describe("Focus this element before pressing"),
      commit,
      reason,
    }),
    ...common,
    ...gated("press"),
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => pressKeys(ctx, args.keys, args.ref)),
        CHANGE,
      ),
  });

  const scroll = tool({
    name: "scroll",
    description:
      "Scroll the page or a scrollable element (ref): by direction and amount (page, half, or pixels), or to top/bottom. Reports the new position, the end of the content, and content that loaded as you scrolled. Prefer find/read_page when you are looking for something specific.",
    inputSchema: z.object({
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      to: z.enum(["top", "bottom"]).optional(),
      amount: z.union([z.enum(["page", "half"]), z.number().positive()]).optional(),
      ref: z.string().optional().describe("Scroll this element's scroll container"),
    }),
    ...common,
    permissionScope: interact,
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) =>
          scrollPage(ctx, {
            ...(args.direction ? { direction: args.direction } : {}),
            ...(args.to ? { to: args.to } : {}),
            ...(args.amount !== undefined ? { amount: args.amount } : {}),
            ...(args.ref ? { ref: args.ref } : {}),
          }),
        ),
      ),
  });

  const hover = tool({
    name: "hover",
    description: "Move the mouse over an element, e.g. to open a hover menu or show a tooltip.",
    inputSchema: z.object({ ref }),
    ...common,
    permissionScope: interact,
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => hoverRef(ctx, args.ref)),
        CHANGE,
      ),
  });

  const drag = tool({
    name: "drag",
    description: "Drag from one element (or point) to another element (or point).",
    inputSchema: z.object({
      from: z.union([z.string().min(1), point]),
      to: z.union([z.string().min(1), point]),
    }),
    ...common,
    permissionScope: interact,
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => dragBetween(ctx, args.from, args.to)),
        CHANGE,
      ),
  });

  const upload = tool({
    name: "upload",
    description:
      "Attach local files to a file input, or to the file chooser opened by clicking an upload button (ref).",
    inputSchema: z.object({ ref, paths: z.array(z.string().min(1)).min(1) }),
    ...common,
    permissionScope: () => "browser:upload",
    permissionDetails: (args) => detailsFor(deps, "upload", args),
    permissionPattern: ({ paths }) => paths.join(","),
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => uploadFiles(ctx, args.ref, args.paths)),
      ),
  });

  const dialog = tool({
    name: "dialog",
    description:
      "Answer the open JavaScript alert/confirm/prompt/beforeunload dialog shown in the page header: accept (OK) or dismiss (Cancel); text answers a prompt.",
    inputSchema: z.object({ action: z.enum(["accept", "dismiss"]), text: z.string().optional() }),
    ...common,
    permissionScope: interact,
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => handleDialog(ctx, args.action, args.text)),
        {
          blockedByDialog: false,
        },
      ),
  });

  const wait = tool({
    name: "wait",
    description: `Wait for text to appear (or disappear with gone: true) on the page, up to seconds (default 10, max ${MAX_WAIT_SECONDS}). Without text, pause for seconds. Actions already wait for the page to settle; use this only for slow background work.`,
    inputSchema: z.object({
      text: z.string().min(1).optional(),
      gone: z.boolean().optional(),
      seconds: z.number().min(0).max(MAX_WAIT_SECONDS).optional(),
    }),
    ...common,
    changesState: false,
    permissionScope: () => "browser:observe",
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => waitFor(ctx, args)),
        { screenshot: false },
      ),
  });

  const evaluate = tool({
    name: "evaluate",
    description:
      "Run JavaScript in the page and return its JSON result: an expression, or a function (receives the element when ref is given). Use only when no other tool can do it.",
    inputSchema: z.object({ function: z.string().min(1), ref: z.string().optional() }),
    ...common,
    permissionScope: () => "browser:script",
    permissionDetails: (args) => detailsFor(deps, "evaluate", args),
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) => evaluateScript(ctx, args.function, args.ref)),
      ),
  });

  const clickXy = tool({
    name: "click_xy",
    description:
      "Click at viewport coordinates from the latest screenshot (CSS pixels as stated in its header). Only for targets without a ref, such as canvas content.",
    inputSchema: z.object({
      x: z.number().min(0),
      y: z.number().min(0),
      button: z.enum(["left", "right", "middle"]).optional(),
      double: z.boolean().optional(),
      commit,
      reason,
    }),
    ...common,
    ...gated("click_xy"),
    execute: (args, { signal }) =>
      pageAction(
        deps,
        signal,
        act(deps, (ctx) =>
          clickPoint(
            ctx,
            { x: args.x, y: args.y },
            {
              ...(args.button ? { button: args.button } : {}),
              ...(args.double ? { double: true } : {}),
            },
          ),
        ),
        CHANGE,
      ),
  });

  const downloads = tool({
    name: "downloads",
    description: "List files downloaded in this session, with their state and saved paths.",
    inputSchema: z.object({}),
    executionMode: "sequential",
    changesState: false,
    permissionScope: () => "browser:observe",
    permissionPattern: () => "*",
    execute: () => ({
      content: [{ type: "text", text: formatDownloads(deps.browser.downloads.list()) }],
      details: { downloads: deps.browser.downloads.list() },
    }),
  });

  return {
    click,
    type,
    fill,
    select,
    press,
    scroll,
    hover,
    drag,
    upload,
    dialog,
    wait,
    evaluate,
    clickXy,
    downloads,
  };
}
