// The mu integration layer: an AgentEvent consumer that retains transcript
// cells and keeps the live region (composer / approval / footer) up to date. It
// holds no agent logic — everything arrives as events.
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  CheckpointDiffFile,
  CompactionProgress,
  PermissionModeTone,
  PermissionRequest,
} from "@mu/core";
import {
  agentCell,
  type CompactionProgressState,
  compactionCell,
  compactionProgressRow,
  compactionTargetPercent,
  diffLinesFromHunks,
  errorCell,
  formatDuration,
  type RenderContext,
  thinkingCell,
  toolOutputCell,
  userCell,
} from "./cells.ts";
import {
  APPROVAL_OPTIONS,
  approvalOverlay,
  BLOCK_CURSOR_ON,
  composerBox,
  composerBoxBottom,
  composerContentWidth,
  composerRule,
  Editor,
  type FooterData,
  footer,
  type QueuedInputKind,
  queuedInputPreview,
  type SelectItem,
  SelectList,
  Spinner,
} from "./components.ts";
import type { InputEvent, Key } from "./input.ts";
import {
  type ActivityKind,
  EXPANDED_OUTPUT_LINES,
  RendererRegistry,
  type SubagentProgressState,
  type ToolRenderInfo,
  updateSubagentProgress,
} from "./registry.ts";
import type { RenderFrame } from "./renderer.ts";
import { AGENT_LABEL, type ColorDepth, GLYPHS, MARGIN, stripAnsi, styleText } from "./style.ts";
import { stringWidth, truncateToWidth } from "./width.ts";
import { terminalRows, wrapText } from "./wrap.ts";

const COLLAPSE_COMMAND = {
  label: "collapse",
  description: "Collapse all expanded tool activity",
};

export type AppMode =
  | "composing"
  | "activity"
  | "approval"
  | "select"
  | "mention"
  | "picker"
  | "prompt";
export type ConversationSource = "main" | "side";

export interface PickerRequest {
  title: string;
  items: SelectItem[];
  onChoose: (value: string) => void;
  onDelete?: (value: string) => void;
  onBack?: () => void;
  onCancel?: () => void;
  filterable?: boolean;
}

export interface InputPromptRequest {
  title: string;
  secret?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}

export interface AppCallbacks {
  // biome-ignore lint/suspicious/noConfusingVoidType: false rejects; no return accepts.
  onSubmit: (text: string) => boolean | void;
  onSteer?: (text: string) => boolean;
  onFollowUp?: (text: string) => boolean;
  onEditQueued?: (kind: QueuedInputKind, text: string) => boolean;
  // Explicit user shell escape. The leading `!` stays in editor history, but
  // only the command text is passed to the surface.
  onShell?: (command: string) => void;
  // Supplies file paths for the `@` mention popup.
  onMentionQuery?: (query: string) => { label: string; description?: string }[];
  onAbort: () => void;
  // Stops one background subagent selected in transcript review.
  // Stops a background subagent or task by its id (x twice in review).
  onStopBackground?: (id: string) => void;
  // Moves running foreground calls to the background (ctrl+z, or b in review).
  onBackgroundTools?: (toolCallIds: string[]) => void;
  onExit: () => void;
  // Present only for a conversation attached from agent view. Plain mu omits
  // it, so Left remains ordinary editor navigation there.
  onDetach?: () => void;
  onPermissionReply?: (
    requestId: string,
    outcome: "allow" | "deny",
    remember: boolean,
    source: ConversationSource,
  ) => void;
  onCommand?: (text: string) => void;
  onThinkingChange?: (level: string) => void;
  onCloseSide?: () => void;
  // Shift+Tab. The surface owns the mode list (profile-defined), so this is
  // just a "cycle to the next one" signal, same shape as onAbort/onExit.
  onCyclePermissionMode?: () => void;
}

export interface AppOptions {
  width: number;
  height?: number;
  depth: ColorDepth;
  model: string;
  version?: string;
  tagline?: string;
  cwd?: string;
  contextWindow?: number;
  thinkingLevels?: readonly string[];
  callbacks: AppCallbacks;
  registry?: RendererRegistry;
}

interface LiveTask {
  taskId: string;
  command: string;
  startedAt: number;
  tail: string[];
  partial: string;
  retainedChars: number;
  omittedLines: number;
  omittedChars: number;
  exit?: Extract<AgentEvent, { type: "task_exited" }>;
}

interface PendingInput {
  kind: QueuedInputKind;
  text: string;
}

function taskOutputLines(task: LiveTask): string[] {
  const lines = [...task.tail, ...(task.partial.length > 0 ? [task.partial] : [])];
  if (task.omittedLines === 0 && task.omittedChars === 0) return lines;
  const omitted = [
    task.omittedLines > 0
      ? `${task.omittedLines.toLocaleString()} earlier line${task.omittedLines === 1 ? "" : "s"}`
      : "",
    task.omittedChars > 0
      ? `${task.omittedChars.toLocaleString()} character${task.omittedChars === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);
  return [
    `… ${omitted.join(" and ")}`,
    "omitted from TUI log",
    "task_output uses a separate bounded model-facing buffer",
    ...lines,
  ];
}

function taskOutputText(task: LiveTask): string {
  return taskOutputLines(task).join("\n");
}

function expandedTaskOutputLines(task: LiveTask): string[] {
  const lines = taskOutputLines(task);
  if (lines.length <= EXPANDED_OUTPUT_LINES) return lines;
  const visible = EXPANDED_OUTPUT_LINES - 1;
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  return [
    ...lines.slice(0, head),
    `… ${lines.length - head - tail} lines omitted from expanded view`,
    ...lines.slice(-tail),
  ];
}

// A bash result describing a task it just spawned, rather than a command it ran
// to completion. `exitCode` is what separates the two.
function backgroundTaskDetails(details: unknown): { taskId: string } | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const record = details as { background?: unknown; taskId?: unknown; exitCode?: unknown };
  if (record.background !== true || typeof record.taskId !== "string") return undefined;
  return record.exitCode === undefined ? { taskId: record.taskId } : undefined;
}

function backgroundSubagentDetails(details: unknown): { subagentId: string } | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const record = details as { type?: unknown; subagentId?: unknown };
  return record.type === "subagent-background" && typeof record.subagentId === "string"
    ? { subagentId: record.subagentId }
    : undefined;
}

interface LiveSubagent {
  progress?: SubagentProgressState;
  ended?: Extract<AgentEvent, { type: "subagent_ended" }>;
}

// Guardrails against a runaway process, independent of core's much tighter
// model-facing token budget. Both dimensions matter: a line count alone still
// permits a small number of enormous lines to exhaust the TUI.
const TASK_RETAINED_LINES = 50_000;
const TASK_RETAINED_CHARS = 5_000_000;
const TASK_RETAINED_LINE_CHARS = 10_000;
// The live row is transient and shares space with the composer.
const TASK_LIVE_TAIL_LINES = 3;
const TASK_PARTIAL_CHARS = 2_000;
const LIVE_TOOL_OUTPUT_LINES = 50;
// How long a backgroundable call runs before its row offers ctrl+z.
export const BACKGROUND_HINT_MS = 5_000;
const PENDING_INPUT_ROWS = 3;

function appendTaskOutput(task: LiveTask, chunk: string): void {
  const parts = `${task.partial}${chunk}`.split(/\r\n|\n|\r/);
  task.partial = parts.pop() ?? "";
  if (task.partial.length > TASK_PARTIAL_CHARS) {
    task.omittedChars += task.partial.length - TASK_PARTIAL_CHARS;
    task.partial = `…${task.partial.slice(-(TASK_PARTIAL_CHARS - 1))}`;
  }
  for (const part of parts) {
    if (part.length <= TASK_RETAINED_LINE_CHARS) {
      task.tail.push(part);
      task.retainedChars += part.length;
      continue;
    }
    task.omittedChars += part.length - TASK_RETAINED_LINE_CHARS;
    const retained = `…${part.slice(-(TASK_RETAINED_LINE_CHARS - 1))}`;
    task.tail.push(retained);
    task.retainedChars += retained.length;
  }
  let dropped = Math.max(0, task.tail.length - TASK_RETAINED_LINES);
  let retainedChars = task.retainedChars;
  for (let index = 0; index < dropped; index++) {
    retainedChars -= task.tail[index]?.length ?? 0;
  }
  while (dropped < task.tail.length && retainedChars + task.partial.length > TASK_RETAINED_CHARS) {
    retainedChars -= task.tail[dropped]?.length ?? 0;
    dropped++;
  }
  if (dropped > 0) {
    task.tail.splice(0, dropped);
    task.retainedChars = retainedChars;
    task.omittedLines += dropped;
  }
}
const MIN_STREAMING_PREVIEW_CHARS = 8_000;
const MAX_STREAMING_PREVIEW_CHARS = 16_000;
const STREAMING_VIEWPORTS = 2;
// Idle Ctrl+C arms a "press again to exit" window instead of exiting on the
// first press, so one stray keystroke can't kill the session.
export const CTRL_C_EXIT_WINDOW_MS = 2_000;

interface MarkdownFence {
  marker: string;
  language?: string;
}

// A completed response is always rendered in full. While it is still growing,
// cap the expensive Markdown/syntax-highlight pass to a few viewports. If the
// retained suffix is inside a fence, recreate that fence so live code keeps
// its language-aware highlighting.
function streamingMarkdownPreview(
  text: string,
  maxChars: number,
): { text: string; omittedChars: number } {
  if (text.length <= maxChars) return { text, omittedChars: 0 };

  let start = text.length - maxChars;
  const nextLine = text.indexOf("\n", start);
  if (nextLine !== -1) start = nextLine + 1;

  const prefix = text.slice(0, start);
  const tail = text.slice(start);
  const fence = openFenceAtEnd(prefix);
  const context = fence ? `${fence.marker}${fence.language ? fence.language : ""}\n${tail}` : tail;
  return {
    text: `… ${start.toLocaleString()} earlier characters retained while streaming\n\n${context}`,
    omittedChars: start,
  };
}

function openFenceAtEnd(text: string): MarkdownFence | undefined {
  let open: MarkdownFence | undefined;
  for (const line of text.split("\n")) {
    if (!open) {
      const match = /^\s*(`{3,}|~{3,})\s*([^ ]*)?.*$/.exec(line);
      if (match?.[1]) {
        open = {
          marker: match[1],
          ...(match[2]?.trim() ? { language: match[2].trim() } : {}),
        };
      }
      continue;
    }
    const close = new RegExp(`^\\s*${open.marker[0]}{${open.marker.length},}\\s*$`);
    if (close.test(line)) open = undefined;
  }
  return open;
}

class LiveToolOutput {
  private lines: string[] = [];
  private partial = "";
  private omitted = 0;
  private afterCarriageReturn = false;

  append(chunk: string): void {
    for (const char of chunk) {
      if (char === "\n" && this.afterCarriageReturn) {
        this.afterCarriageReturn = false;
        continue;
      }
      if (char === "\n" || char === "\r") {
        this.finishLine();
        this.afterCarriageReturn = char === "\r";
        continue;
      }
      this.afterCarriageReturn = false;
      this.partial += char;
      if (this.partial.length > TASK_PARTIAL_CHARS) {
        this.partial = `…${this.partial.slice(-(TASK_PARTIAL_CHARS - 1))}`;
      }
    }
  }

  display(maxLines: number): string[] {
    const retained = [...this.lines, ...(this.partial.length > 0 ? [this.partial] : [])];
    const total = this.omitted + retained.length;
    if (total <= maxLines) return retained;
    const visibleCount = Math.max(1, maxLines - 1);
    const visible = retained.slice(-visibleCount);
    const hidden = total - visible.length;
    return [`… ${hidden} earlier lines · ctrl+o to expand`, ...visible];
  }

  private finishLine(): void {
    this.lines.push(this.partial);
    this.partial = "";
    if (this.lines.length > LIVE_TOOL_OUTPUT_LINES) {
      const removed = this.lines.length - LIVE_TOOL_OUTPUT_LINES;
      this.lines.splice(0, removed);
      this.omitted += removed;
    }
  }
}

type PendingTool = Omit<ToolRenderInfo, "expanded"> & {
  id: string;
  expanded: boolean;
  output: LiveToolOutput;
  startedAt?: number;
  // A backgrounded command's tool call returns the moment the process spawns,
  // but the row it owns stays live until the task itself exits, so its output
  // lands under the command that produced it instead of floating on its own.
  taskId?: string;
  // The same for a subagent started with run_in_background.
  subagentId?: string;
  // The agent can move this running call to the background.
  backgroundable?: boolean;
};
interface ActivityTool {
  id: string;
  info: ToolRenderInfo;
  expanded: boolean;
  // A thinking-only turn that came between this call and the previous one in
  // its group, kept here so it does not split the group.
  thinking?: AssistantMessage;
  rendered?: { width: number; expanded: boolean; lines: string[] };
}

type ActivityNode =
  | { id: string; item: TranscriptItem; tool?: ActivityTool }
  | { id: string; pending: PendingTool };

interface ActivitySearchMatch {
  row: number;
  start: number;
  length: number;
}

interface ActivitySearch {
  editor: Editor;
  editing: boolean;
  showing: boolean;
  query: string;
  rows: string[];
  matches: ActivitySearchMatch[];
  matchIndex: number;
  transcriptVersion: number;
  width: number;
}

type TranscriptItem =
  | { kind: "lines"; lines: string[] }
  | { kind: "user"; text: string; pending?: boolean }
  | {
      kind: "assistant";
      message: AssistantMessage;
      rendered?: { width: number; lines: string[] };
    }
  | {
      kind: "tool";
      id: string;
      info: ToolRenderInfo;
      expanded: boolean;
      rendered?: { width: number; expanded: boolean; superseded: boolean; lines: string[] };
    }
  | {
      kind: "activity";
      id: string;
      activityKind: ActivityKind;
      group?: string;
      tools: ActivityTool[];
      expanded: boolean;
    };

const SUBAGENT_TOOL_NAMES = new Set(["task", "search", "recall", "counsel"]);

function isSubagentTool(item: TranscriptItem | undefined): boolean {
  return item?.kind === "tool" && SUBAGENT_TOOL_NAMES.has(item.info.toolName);
}

function hasAssistantText(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
}

function hasAssistantDisplay(message: AssistantMessage): boolean {
  return message.content.some(
    (block) =>
      (block.type === "thinking" && block.thinking.trim().length > 0) ||
      (block.type === "text" && block.text.trim().length > 0),
  );
}

function webSearchDetail(event: Extract<AgentEvent, { type: "web_search_end" }>): string {
  const action = event.search.action;
  if (action?.type === "search") return action.query ?? action.queries?.join(", ") ?? "web";
  if (action?.type === "openPage") return action.url ?? "page";
  if (action?.type === "findInPage") {
    return [action.pattern ? `“${action.pattern}”` : undefined, action.url]
      .filter(Boolean)
      .join(" in ");
  }
  return "web";
}

interface ConversationView {
  editor: Editor;
  running: boolean;
  // The newest completed tool of the current run, and what the agent is waiting
  // for from the user if that tool handed the turn over.
  lastTool: ToolRenderInfo | undefined;
  awaitingUser: string | undefined;
  runStartedAt: number;
  compacting: boolean;
  compactionStage: "clearing-tool-output" | "summarizing" | "installing" | undefined;
  compactionProgress: CompactionProgress | undefined;
  compactionWaitingSince: number;
  // Eased on spinner ticks so repaints for other reasons do not speed it up.
  compactionPercent: number;
  pendingTools: Map<string, PendingTool>;
  pendingInputs: PendingInput[];
  webSearchBoundaryPending: boolean;
  transcript: TranscriptItem[];
  transcriptVersion: number;
  transcriptCache:
    | {
        version: number;
        width: number;
        rows: string[];
      }
    | undefined;
  streaming: string | undefined;
  streamingCache:
    | {
        text: string;
        width: number;
        height: number;
        rows: string[];
      }
    | undefined;
  lastError: string | undefined;
  footerData: FooterData;
  thinkingLevel: string;
  thinkingLevels: string[];
  permissionMode: { label: string; tone?: PermissionModeTone | undefined } | undefined;
  activitySelection: string | undefined;
  activitySearch: ActivitySearch | undefined;
}

function conversationView(
  footerData: FooterData,
  thinkingLevels: readonly string[],
): ConversationView {
  return {
    editor: new Editor(),
    running: false,
    lastTool: undefined,
    awaitingUser: undefined,
    runStartedAt: 0,
    compacting: false,
    compactionStage: undefined,
    compactionProgress: undefined,
    compactionWaitingSince: 0,
    compactionPercent: 0,
    pendingTools: new Map(),
    pendingInputs: [],
    webSearchBoundaryPending: false,
    transcript: [],
    transcriptVersion: 0,
    transcriptCache: undefined,
    streaming: undefined,
    streamingCache: undefined,
    lastError: undefined,
    footerData,
    thinkingLevel: thinkingLevels[0] ?? "off",
    thinkingLevels: [...thinkingLevels],
    permissionMode: undefined,
    activitySelection: undefined,
    activitySearch: undefined,
  };
}

export class App {
  readonly registry: RendererRegistry;
  private spinner = new Spinner();
  private commandList = new SelectList([]);
  private mode: AppMode = "composing";
  // A parallel-safe tool batch can raise several asks at once, so they queue
  // rather than overwriting each other. One is shown; resolving removes only
  // the matching id and advances to the next.
  private approvals: { request: PermissionRequest; source: ConversationSource }[] = [];
  private approvalIndex = 0;
  private main: ConversationView;
  private side: ConversationView | undefined;
  private activeSource: ConversationSource = "main";
  private eventView: ConversationView | undefined;
  private eventSource: ConversationSource = "main";
  private mainStatus:
    | "working"
    | "needs approval"
    | "interrupted"
    | "failed"
    | "finished"
    | undefined;
  private backgroundTasks = new Map<string, LiveTask>();
  private backgroundSubagents = new Map<string, LiveSubagent>();
  // A first `x` on a running background subagent arms its stop; the second sends it.
  private stopArmedFor: string | undefined;
  private ctrlCArmedAt = 0;
  private commands: { label: string; description?: string }[] = [COLLAPSE_COMMAND];
  private picker: PickerRequest | undefined;
  private pickerQuery = "";
  private pickerDeleteValue: string | undefined;
  private prompt: InputPromptRequest | undefined;
  private promptEditor = new Editor();
  private mentionStart = -1;

  constructor(private options: AppOptions) {
    this.registry = options.registry ?? new RendererRegistry();
    const thinkingLevels = [
      ...new Set(options.thinkingLevels ?? ["off", "low", "medium", "high"]),
    ] as string[];
    this.main = conversationView(
      {
        cwd: options.cwd ?? ".",
        model: options.model,
        contextPercent: 0,
        contextWindow: options.contextWindow ?? 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
      thinkingLevels,
    );
  }

  private get view(): ConversationView {
    return this.eventView ?? (this.activeSource === "side" && this.side ? this.side : this.main);
  }

  get editor(): Editor {
    return this.activeSource === "side" && this.side ? this.side.editor : this.main.editor;
  }

  private get running(): boolean {
    return this.view.running;
  }
  private set running(value: boolean) {
    this.view.running = value;
  }
  private get runStartedAt(): number {
    return this.view.runStartedAt;
  }
  private set runStartedAt(value: number) {
    this.view.runStartedAt = value;
  }
  private get compacting(): boolean {
    return this.view.compacting;
  }
  private set compacting(value: boolean) {
    this.view.compacting = value;
  }
  private get compactionStage(): ConversationView["compactionStage"] {
    return this.view.compactionStage;
  }
  private set compactionStage(value: ConversationView["compactionStage"]) {
    this.view.compactionStage = value;
  }
  private get pendingTools(): Map<string, PendingTool> {
    return this.view.pendingTools;
  }
  private get pendingInputs(): PendingInput[] {
    return this.view.pendingInputs;
  }
  private set pendingInputs(value: PendingInput[]) {
    this.view.pendingInputs = value;
  }
  private get webSearchBoundaryPending(): boolean {
    return this.view.webSearchBoundaryPending;
  }
  private set webSearchBoundaryPending(value: boolean) {
    this.view.webSearchBoundaryPending = value;
  }
  private get transcript(): TranscriptItem[] {
    return this.view.transcript;
  }
  private set transcript(value: TranscriptItem[]) {
    this.view.transcript = value;
  }
  private get transcriptVersion(): number {
    return this.view.transcriptVersion;
  }
  private set transcriptVersion(value: number) {
    this.view.transcriptVersion = value;
  }
  private get transcriptCache(): ConversationView["transcriptCache"] {
    return this.view.transcriptCache;
  }
  private set transcriptCache(value: ConversationView["transcriptCache"]) {
    this.view.transcriptCache = value;
  }
  private get activitySelection(): string | undefined {
    return this.view.activitySelection;
  }
  private set activitySelection(value: string | undefined) {
    this.view.activitySelection = value;
  }
  private get activitySearch(): ActivitySearch | undefined {
    return this.view.activitySearch;
  }
  private set activitySearch(value: ActivitySearch | undefined) {
    this.view.activitySearch = value;
  }
  private get streaming(): string | undefined {
    return this.view.streaming;
  }
  private set streaming(value: string | undefined) {
    this.view.streaming = value;
  }
  private get streamingCache(): ConversationView["streamingCache"] {
    return this.view.streamingCache;
  }
  private set streamingCache(value: ConversationView["streamingCache"]) {
    this.view.streamingCache = value;
  }
  private get lastError(): string | undefined {
    return this.view.lastError;
  }
  private set lastError(value: string | undefined) {
    this.view.lastError = value;
  }
  private get footerData(): FooterData {
    return this.view.footerData;
  }
  private set footerData(value: FooterData) {
    this.view.footerData = value;
  }
  private get thinkingLevel(): string {
    return this.view.thinkingLevel;
  }
  private set thinkingLevel(value: string) {
    this.view.thinkingLevel = value;
  }
  private get thinkingLevels(): string[] {
    return this.view.thinkingLevels;
  }
  private set thinkingLevels(value: string[]) {
    this.view.thinkingLevels = value;
  }

  private get ctx(): RenderContext {
    return {
      width: this.options.width,
      depth: this.options.depth,
      spinner: this.spinner.glyph,
      spinnerFrame: this.spinner.frameIndex,
    };
  }

  setWidth(width: number): void {
    this.options.width = width;
  }

  setSize(width: number, height: number): void {
    this.options.width = width;
    this.options.height = height;
  }

  setCommands(commands: { label: string; description?: string }[]): void {
    this.commands = [
      ...commands.filter((command) => command.label !== COLLAPSE_COMMAND.label),
      COLLAPSE_COMMAND,
    ];
  }

  get activeConversation(): ConversationSource {
    return this.activeSource;
  }

  get hasSideConversation(): boolean {
    return this.side !== undefined;
  }

  openSideConversation(
    model: string,
    contextWindow: number,
    thinkingLevels: readonly string[],
  ): void {
    const footerData: FooterData = {
      cwd: this.main.footerData.cwd,
      model,
      contextPercent: 0,
      contextWindow,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      ...(this.main.footerData.status ? { status: this.main.footerData.status } : {}),
    };
    this.side = conversationView(footerData, thinkingLevels);
    this.activeSource = "side";
    this.syncSideFooter();
    this.replaceTranscript(
      [],
      [
        composerRule(this.options.width, this.options.depth),
        `${MARGIN}${styleText("side conversation · inherited context is reference only · esc to close", { dim: true }, this.options.depth)}`,
        "",
      ],
    );
  }

  toggleSideConversation(): void {
    if (!this.side) return;
    this.activeSource = this.activeSource === "side" ? "main" : "side";
    this.mode = this.approvals.length > 0 ? "approval" : "composing";
  }

  closeSideConversation(): void {
    if (!this.side) return;
    this.side = undefined;
    this.activeSource = "main";
    this.approvals = this.approvals.filter((item) => item.source !== "side");
    this.mode = this.approvals.length > 0 ? "approval" : "composing";
  }

  private syncSideFooter(): void {
    if (!this.side) return;
    const status = this.mainStatus ? ` · main ${this.mainStatus}` : "";
    this.side.footerData = {
      ...this.side.footerData,
      side: `from main${status} · ctrl+b switch · esc close`,
    };
  }

  setModel(
    model: string,
    contextWindow?: number,
    source: ConversationSource = this.activeSource,
  ): void {
    const previous = this.eventView;
    this.eventView = source === "side" ? this.side : this.main;
    if (!this.eventView) {
      this.eventView = previous;
      return;
    }
    this.footerData = {
      ...this.footerData,
      model,
      contextPercent: 0,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
    this.eventView = previous;
  }

  setFooterStatus(status: string | undefined): void {
    const update = (view: ConversationView) => {
      const { status: _previous, ...footerData } = view.footerData;
      view.footerData = { ...footerData, ...(status ? { status } : {}) };
    };
    update(this.main);
    if (this.side) update(this.side);
  }

  // Shown in place of the thinking shortcut so the footer names what mu may do.
  setPermissionMode(
    mode: { label: string; tone?: PermissionModeTone | undefined } | undefined,
    source: ConversationSource = this.activeSource,
  ): void {
    const view = source === "side" ? this.side : this.main;
    if (view) view.permissionMode = mode;
  }

  setThinking(
    level: string,
    levels?: readonly string[],
    source: ConversationSource = this.activeSource,
  ): void {
    const previous = this.eventView;
    this.eventView = source === "side" ? this.side : this.main;
    if (!this.eventView) {
      this.eventView = previous;
      return;
    }
    if (levels && levels.length > 0) this.thinkingLevels = [...new Set(levels)];
    this.thinkingLevel = this.thinkingLevels.includes(level)
      ? level
      : (this.thinkingLevels[0] ?? "off");
    this.eventView = previous;
  }

  get thinking(): string {
    return this.thinkingLevel;
  }

  get areToolOutputsExpanded(): boolean {
    return (
      [...this.pendingTools.values()].some((pending) => pending.expanded) ||
      this.transcript.some(
        (item) =>
          (item.kind === "tool" && item.expanded) ||
          (item.kind === "activity" && (item.expanded || item.tools.some((tool) => tool.expanded))),
      )
    );
  }

  get isShellMode(): boolean {
    return this.options.callbacks.onShell !== undefined && this.editor.text.startsWith("!");
  }

  // Opens a selection list (used by /model and /resume).
  openPicker(request: PickerRequest): void {
    this.picker = request;
    this.pickerQuery = "";
    this.pickerDeleteValue = undefined;
    this.commandList.setItems(request.items);
    this.mode = "picker";
  }

  updatePicker(request: PickerRequest, update: Pick<PickerRequest, "title" | "items">): boolean {
    if (this.mode !== "picker" || this.picker !== request) return false;
    const selected = this.commandList.selected;
    request.title = update.title;
    request.items = update.items;
    this.pickerDeleteValue = undefined;
    this.refreshPicker(selected ? (selected.value ?? selected.label) : undefined);
    return true;
  }

  openCommandMenu(): void {
    this.editor.setText("/");
    this.commandList.setItems(this.commands);
    this.mode = "select";
  }

  openPrompt(request: InputPromptRequest): void {
    this.prompt = request;
    this.promptEditor.setText("");
    this.mode = "prompt";
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentMode(): AppMode {
    return this.mode;
  }

  // True while a first idle Ctrl+C is armed, waiting for a confirming second
  // press within CTRL_C_EXIT_WINDOW_MS.
  get ctrlCPending(): boolean {
    return this.ctrlCArmedAt !== 0 && Date.now() - this.ctrlCArmedAt < CTRL_C_EXIT_WINDOW_MS;
  }

  // Events that produce transcript output return their rendered lines for
  // callers that inspect events directly; all durable output is also retained
  // as semantic transcript cells for whole-screen rendering.
  handleEvent(event: AgentEvent, source: ConversationSource = "main"): string[] {
    const target = source === "side" ? this.side : this.main;
    if (!target) return [];
    this.eventView = target;
    this.eventSource = source;
    try {
      return this.handleConversationEvent(event);
    } finally {
      this.eventView = undefined;
      this.eventSource = this.activeSource;
    }
  }

  private handleConversationEvent(event: AgentEvent): string[] {
    switch (event.type) {
      case "agent_start":
        this.running = true;
        this.view.lastTool = undefined;
        this.view.awaitingUser = undefined;
        this.runStartedAt = Date.now();
        if (this.eventSource === "main") {
          this.mainStatus = "working";
          this.syncSideFooter();
        }
        return [];

      case "agent_end": {
        this.clearPendingSubmissions();
        this.webSearchBoundaryPending = false;
        this.running = false;
        this.compacting = false;
        this.compactionStage = undefined;
        const lastTool = this.view.lastTool;
        this.view.awaitingUser =
          event.reason === "done" && lastTool ? this.registry.awaitsUser(lastTool) : undefined;
        if (this.eventSource === "main") {
          this.mainStatus =
            event.reason === "error"
              ? "failed"
              : event.reason === "aborted"
                ? "interrupted"
                : "finished";
          this.syncSideFooter();
        }
        const duration = styleText(
          `worked for ${formatDuration(Date.now() - this.runStartedAt)}`,
          { dim: true },
          this.ctx.depth,
        );
        if (event.reason !== "error") {
          const lines = [MARGIN + duration, ""];
          this.appendTranscript(lines);
          return lines;
        }
        // Show *why* it failed. "run ended with an error" tells the user
        // nothing and hides actionable messages like a missing API key.
        const detail = this.lastError ?? "the provider returned an error";
        this.lastError = undefined;
        const lines = [...errorCell(detail, this.ctx), MARGIN + duration, ""];
        this.appendTranscript(lines);
        return lines;
      }

      case "message_start":
        if (event.message.role === "assistant") {
          this.streaming = "";
          this.streamingCache = undefined;
        }
        return [];

      case "message_update":
        if (event.delta.kind === "text_delta") {
          if (this.webSearchBoundaryPending) {
            this.appendTranscript([""]);
            this.webSearchBoundaryPending = false;
          }
          this.streaming = (this.streaming ?? "") + event.delta.text;
          this.streamingCache = undefined;
        } else if (
          event.delta.kind === "toolcall_start" ||
          event.delta.kind === "toolcall_delta" ||
          event.delta.kind === "toolcall_end"
        ) {
          const block = event.message.content[event.delta.contentIndex];
          if (block?.type === "toolCall" && block.id) {
            const existing = this.pendingTools.get(block.id);
            this.pendingTools.set(block.id, {
              id: block.id,
              toolName: block.name,
              args: block.arguments,
              argsStreaming: event.delta.kind !== "toolcall_end",
              running: existing?.running ?? false,
              expanded: existing?.expanded ?? false,
              output: existing?.output ?? new LiveToolOutput(),
              ...(existing?.progress !== undefined ? { progress: existing.progress } : {}),
              ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
            });
          }
        }
        return [];

      case "tool_execution_update": {
        const pending = this.pendingTools.get(event.toolCallId);
        if (pending) {
          for (const block of event.partial) {
            if (block.type === "text") pending.output.append(block.text);
          }
          const progress = updateSubagentProgress(pending.progress, event.details);
          if (progress) pending.progress = progress;
        }
        return [];
      }

      case "message_end": {
        const message = event.message;
        if (message.role === "user") {
          this.webSearchBoundaryPending = false;
          const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          if (!text) return [];
          const pendingIndex = this.pendingInputs.findIndex(
            (pending) => pending.kind === "steer" && pending.text === text,
          );
          const deliveredIndex =
            pendingIndex === -1
              ? this.pendingInputs.findIndex(
                  (pending) => pending.kind === "follow-up" && pending.text === text,
                )
              : pendingIndex;
          if (deliveredIndex !== -1) this.pendingInputs.splice(deliveredIndex, 1);
          const submitted = this.transcript.find(
            (item): item is Extract<TranscriptItem, { kind: "user" }> =>
              item.kind === "user" && item.pending === true,
          );
          if (submitted) {
            submitted.text = text;
            submitted.pending = false;
            this.transcriptVersion++;
            this.transcriptCache = undefined;
          } else {
            this.pushTranscript({ kind: "user", text });
          }
          return [...userCell(text, this.ctx), ""];
        }
        if (message.role === "assistant") {
          this.streaming = undefined;
          this.streamingCache = undefined;
          if (message.stopReason === "error" && message.errorMessage) {
            this.lastError = message.errorMessage;
          }
          if (hasAssistantDisplay(message)) {
            if (this.webSearchBoundaryPending) this.appendTranscript([""]);
            this.webSearchBoundaryPending = false;
            this.pushTranscript({ kind: "assistant", message });
          }
          return [];
        }
        return [];
      }

      case "tool_execution_start":
        {
          const existing = this.pendingTools.get(event.toolCallId);
          this.pendingTools.set(event.toolCallId, {
            id: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            running: true,
            expanded: existing?.expanded ?? false,
            output: existing?.output ?? new LiveToolOutput(),
            ...(existing?.progress !== undefined ? { progress: existing.progress } : {}),
            startedAt: existing?.startedAt ?? Date.now(),
            ...(event.backgroundable ? { backgroundable: true } : {}),
          });
        }
        return [];

      case "tool_execution_end": {
        const pending = this.pendingTools.get(event.toolCallId);
        const started = backgroundTaskDetails(event.result.details);
        if (pending && started) {
          pending.result = event.result;
          pending.taskId = started.taskId;
          pending.running = true;
          return this.completeBackgroundTask(started.taskId) ?? [];
        }
        const delegated = backgroundSubagentDetails(event.result.details);
        if (pending && delegated) {
          pending.result = event.result;
          pending.subagentId = delegated.subagentId;
          pending.running = true;
          const live = this.backgroundSubagents.get(delegated.subagentId);
          // A call moved mid-run already shows its activity; background progress continues it.
          if (live?.progress) pending.progress = live.progress;
          else if (live && pending.progress)
            live.progress = pending.progress as SubagentProgressState;
          return this.completeBackgroundSubagent(delegated.subagentId) ?? [];
        }
        this.pendingTools.delete(event.toolCallId);
        const info: ToolRenderInfo = {
          toolName: pending?.toolName ?? event.result.toolName,
          args: pending?.args ?? {},
          result: event.result,
        };
        this.view.lastTool = info;
        const lines = this.registry.render(info, this.ctx);
        const expanded =
          pending && this.registry.supportsLiveExpansion(pending.toolName)
            ? pending.expanded
            : undefined;
        this.pushTool(event.toolCallId, info, lines, expanded);
        return lines;
      }

      case "web_search_start":
        return [];

      case "web_search_end": {
        const lines = [
          MARGIN + styleText(`searched · ${webSearchDetail(event)}`, { dim: true }, this.ctx.depth),
        ];
        this.appendTranscript(lines);
        this.webSearchBoundaryPending = true;
        return lines;
      }

      case "permission_asked":
        this.approvals.push({ request: event.request, source: this.eventSource });
        if (this.eventSource === "main") {
          this.mainStatus = "needs approval";
          this.syncSideFooter();
        }
        this.approvalIndex = 0;
        this.mode = "approval";
        return [];

      case "permission_resolved": {
        const before = this.approvals.length;
        this.approvals = this.approvals.filter(
          (item) => item.request.id !== event.requestId || item.source !== this.eventSource,
        );
        // A resolution for an id we never showed must not close another ask.
        if (this.approvals.length === before) return [];
        this.approvalIndex = 0;
        if (this.approvals.length === 0) this.mode = "composing";
        if (this.eventSource === "main" && this.mainStatus === "needs approval") {
          this.mainStatus = this.approvals.some((item) => item.source === "main")
            ? "needs approval"
            : this.main.running
              ? "working"
              : undefined;
          this.syncSideFooter();
        }
        return [];
      }

      case "compaction_start":
        this.compacting = event.layer !== 1;
        this.compactionStage = this.compacting ? "summarizing" : undefined;
        this.view.compactionProgress = undefined;
        this.view.compactionWaitingSince = Date.now();
        this.view.compactionPercent = 0;
        return [];

      case "compaction_update": {
        const view = this.view;
        if (!this.compacting) {
          view.compactionProgress = undefined;
          view.compactionPercent = 0;
        }
        if (
          (event.stage === "summarizing" && this.compactionStage !== "summarizing") ||
          (event.progress && event.progress.request !== view.compactionProgress?.request)
        ) {
          view.compactionWaitingSince = Date.now();
        }
        this.compacting = true;
        this.compactionStage = event.stage;
        if (event.progress) view.compactionProgress = event.progress;
        return [];
      }

      case "compaction_end": {
        this.compacting = false;
        this.compactionStage = undefined;
        // Layer 1 is per-turn housekeeping without a model call (expired tool output,
        // superseded results); the footer's context gauge already shows its effect.
        if (event.layer === 1 && event.status !== "failed" && event.status !== "cancelled") {
          return [];
        }
        const lines =
          event.status === "failed" || event.status === "cancelled"
            ? [
                ...errorCell(
                  event.errorMessage ?? "Compaction failed; original context preserved.",
                  this.ctx,
                ),
                "",
              ]
            : [
                ...compactionCell(event.tokensFreed, this.ctx, {
                  ...(event.status ? { status: event.status } : {}),
                  ...(event.contextTokensBefore !== undefined
                    ? { contextTokensBefore: event.contextTokensBefore }
                    : {}),
                  ...(event.contextTokensAfter !== undefined
                    ? { contextTokensAfter: event.contextTokensAfter }
                    : {}),
                  ...(event.toolResultsCleared !== undefined
                    ? { toolResultsCleared: event.toolResultsCleared }
                    : {}),
                  ...(event.keptTokens !== undefined ? { keptTokens: event.keptTokens } : {}),
                }),
                "",
              ];
        this.appendTranscript(lines);
        return lines;
      }

      case "usage_updated":
        this.footerData = {
          ...this.footerData,
          contextPercent: event.contextPercent,
          inputTokens: event.sessionTotals.inputTokens,
          outputTokens: event.sessionTotals.outputTokens,
          costUsd: event.sessionTotals.costUsd ?? 0,
        };
        return [];

      case "task_started": {
        const task: LiveTask = {
          taskId: event.taskId,
          command: event.command,
          startedAt: event.startedAt ?? Date.now(),
          tail: [],
          partial: "",
          retainedChars: 0,
          omittedLines: 0,
          omittedChars: 0,
        };
        this.backgroundTasks.set(event.taskId, task);
        this.adoptRestoredBackgroundOwner(event.taskId);
        this.syncBackgroundCount();
        return [];
      }

      case "thinking_adjusted": {
        const reason = event.inferredModel ? " (not in mu's model catalog)" : "";
        const lines = [
          MARGIN +
            styleText(
              `thinking · ${event.model} does not offer ${event.requested}${reason}; using ${event.level}`,
              { dim: true },
              this.ctx.depth,
            ),
        ];
        this.appendTranscript(lines);
        return lines;
      }

      case "task_output": {
        const task = this.backgroundTasks.get(event.taskId);
        if (!task) return [];
        appendTaskOutput(task, event.chunk);
        return [];
      }

      case "task_exited": {
        const task = this.backgroundTasks.get(event.taskId);
        if (!task) return [];
        task.exit = event;
        this.syncBackgroundCount();
        return this.completeBackgroundTask(event.taskId) ?? [];
      }

      case "subagent_started": {
        this.backgroundSubagents.set(event.subagentId, {});
        this.adoptRestoredSubagentOwner(event.subagentId);
        this.syncBackgroundCount();
        return [];
      }

      case "subagent_progress": {
        const live = this.backgroundSubagents.get(event.subagentId);
        if (!live) return [];
        const progress = updateSubagentProgress(live.progress, event.details);
        if (!progress) return [];
        live.progress = progress;
        const owner = this.subagentOwner(event.subagentId);
        if (owner) owner.progress = progress;
        return [];
      }

      case "subagent_ended": {
        const live = this.backgroundSubagents.get(event.subagentId);
        if (!live) return [];
        live.ended = event;
        this.syncBackgroundCount();
        return this.completeBackgroundSubagent(event.subagentId) ?? [];
      }

      default:
        return [];
    }
  }

  // Shown once at startup: an empty screen with a bare prompt gives the user
  // nothing to orient against.
  banner(): string[] {
    const { depth, width } = this.ctx;
    const shell = this.options.callbacks.onShell ? ` ${GLYPHS.separator} ! for shell` : "";
    const version = this.options.version
      ? ` ${styleText(`v${this.options.version}`, { dim: true }, depth)}`
      : "";
    const affordances = styleText(
      `${this.footerData.model} ${GLYPHS.separator} / for commands ${GLYPHS.separator} @ for files${shell} ${GLYPHS.separator} ctrl+o review ${GLYPHS.separator} ctrl+t thinking ${GLYPHS.separator} ctrl+c to exit`,
      { dim: true },
      depth,
    );
    return [
      "",
      `${MARGIN}${styleText(AGENT_LABEL, { accent: true, bold: true }, depth)}${version}  ${styleText(
        this.options.tagline ?? "a general-purpose, extensible agent",
        { dim: true },
        depth,
      )}`,
      ...wrapText(affordances, width - MARGIN.length).map((line) => MARGIN + line),
      "",
    ];
  }

  // Subagent rows animate and count elapsed time while the main agent is idle.
  get hasRunningSubagents(): boolean {
    return [...this.backgroundSubagents.values()].some((live) => !live.ended);
  }

  tickSpinner(): void {
    this.spinner.tick();
    const view = this.view;
    if (!view.compacting || !view.compactionStage) return;
    const gap = compactionTargetPercent(this.compactionState()) - view.compactionPercent;
    if (gap > 0)
      view.compactionPercent = Math.min(
        99,
        view.compactionPercent + Math.max(gap * 0.35, Math.min(gap, 0.1)),
      );
  }

  private compactionState(): CompactionProgressState {
    const view = this.view;
    return {
      stage: view.compactionStage ?? "summarizing",
      ...(view.compactionProgress ? { progress: view.compactionProgress } : {}),
      waitingMs: Math.max(0, Date.now() - view.compactionWaitingSince),
    };
  }

  appendTranscript(lines: string[], source: ConversationSource = this.activeSource): void {
    const previous = this.eventView;
    this.eventView = source === "side" ? this.side : this.main;
    if (!this.eventView) {
      this.eventView = previous;
      return;
    }
    if (lines.length > 0) this.pushTranscript({ kind: "lines", lines: [...lines] });
    this.eventView = previous;
  }

  discardPendingSubmissions(source: ConversationSource = this.activeSource): void {
    const previous = this.eventView;
    this.eventView = source === "side" ? this.side : this.main;
    if (this.eventView) this.clearPendingSubmissions();
    this.eventView = previous;
  }

  replaceTranscript(messages: readonly AgentMessage[], prefix: string[] = []): void {
    this.transcript = prefix.length > 0 ? [{ kind: "lines", lines: [...prefix] }] : [];
    this.transcriptVersion++;
    this.transcriptCache = undefined;
    this.pendingTools.clear();
    this.backgroundSubagents.clear();
    this.syncBackgroundCount();
    this.pendingInputs = [];
    this.webSearchBoundaryPending = false;
    this.streaming = undefined;
    this.streamingCache = undefined;
    this.activitySelection = undefined;
    this.activitySearch = undefined;
    if (this.mode === "activity") this.mode = "composing";

    const calls = new Map<string, { toolName: string; args: unknown }>();
    const history: string[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text) {
          history.push(text);
          this.pushTranscript({ kind: "user", text });
        }
        continue;
      }
      if (message.role === "assistant") {
        if (hasAssistantDisplay(message)) this.pushTranscript({ kind: "assistant", message });
        for (const block of message.content) {
          if (block.type === "toolCall") {
            calls.set(block.id, { toolName: block.name, args: block.arguments });
          }
        }
        continue;
      }
      if (message.role === "toolResult") {
        const call = calls.get(message.toolCallId);
        const info = {
          toolName: call?.toolName ?? message.toolName,
          args: call?.args ?? {},
          result: message,
        };
        this.pushTool(message.toolCallId, info);
        calls.delete(message.toolCallId);
        continue;
      }
      if (message.customType === "background_subagent") this.restoreSubagentResult(message.details);
    }
    this.editor.replaceHistory(history);
  }

  renderScreen(): string[] {
    const frame = this.renderFrame();
    return [...frame.transcript, ...frame.managed];
  }

  renderFrame(): RenderFrame {
    const search = this.activitySearch;
    if (
      this.mode === "activity" &&
      search &&
      !search.editing &&
      (search.transcriptVersion !== this.transcriptVersion || search.width !== this.options.width)
    ) {
      this.refreshActivitySearch(search);
    }
    const managed = this.fitToViewport(this.toTerminalRows(this.renderManaged()));
    if (this.mode === "activity") {
      const match = search && !search.editing ? search.matches[search.matchIndex] : undefined;
      const rows =
        search && match
          ? search.rows.map((line, index) =>
              index === match.row ? this.highlightSearchMatch(line, match) : line,
            )
          : [
              ...this.transcriptRows(this.activitySelection),
              ...this.pendingActivityRows(this.activitySelection),
            ];
      const limit = Math.max(1, (this.options.height ?? 24) - managed.length);
      const selected = Math.max(0, match?.row ?? rows.findIndex((line) => line.includes("❯")));
      const start = Math.max(0, Math.min(selected - 2, rows.length - limit));
      return {
        transcript: rows.slice(start, start + limit),
        managed,
        dirtyFrom: 0,
      };
    }
    const transcript = this.transcriptRows();
    return {
      transcript,
      managed,
      dirtyFrom: transcript.length,
    };
  }

  renderTranscript(source: ConversationSource = this.activeSource): string[] {
    const previous = this.eventView;
    this.eventView = source === "side" ? this.side : this.main;
    const rows = this.eventView ? [...this.transcriptRows()] : [];
    this.eventView = previous;
    return rows;
  }

  renderBottom(): string[] {
    return this.fitToViewport(this.toTerminalRows(this.renderManaged()));
  }

  private transcriptRows(selectedId?: string, revealAll = false): string[] {
    const cached = this.transcriptCache;
    if (
      !revealAll &&
      selectedId === undefined &&
      cached?.version === this.transcriptVersion &&
      cached.width === this.options.width
    ) {
      return cached.rows;
    }
    // A tool whose calls replace one another leaves only its newest call still
    // true; the rest are history and say so themselves.
    const newest = new Map<string, number>();
    this.transcript.forEach((item, index) => {
      if (item.kind === "tool" && this.registry.supersedes(item.info.toolName)) {
        newest.set(item.info.toolName, index);
      }
    });
    const logical = this.transcript.flatMap((item, index) => {
      if (item.kind === "lines") return item.lines;
      if (item.kind === "user") return [...userCell(item.text, this.ctx), ""];
      if (item.kind === "assistant") {
        if (revealAll) return [...this.assistantRows(item.message, true), ""];
        if (item.rendered?.width !== this.options.width) {
          item.rendered = {
            width: this.options.width,
            lines: this.assistantRows(item.message),
          };
        }
        return [...item.rendered.lines, ""];
      }
      if (item.kind === "activity") {
        const lines = this.renderActivity(item, selectedId, revealAll);
        const next = this.transcript[index + 1];
        // A single one-row call runs on into the next call like any tool row; a
        // group always gets air after it.
        const tight =
          item.tools.length === 1 &&
          (next?.kind === "activity" || (next?.kind === "tool" && lines.length === 1));
        return tight ? lines : [...lines, ""];
      }
      const superseded = newest.has(item.info.toolName) && newest.get(item.info.toolName) !== index;
      if (
        item.rendered?.width !== this.options.width ||
        item.rendered.expanded !== item.expanded ||
        item.rendered.superseded !== superseded
      ) {
        item.rendered = {
          width: this.options.width,
          expanded: item.expanded,
          superseded,
          lines: this.registry.render(
            { ...item.info, expanded: item.expanded, superseded },
            this.ctx,
          ),
        };
      }
      // A run of one-line calls reads as one stream and stays tight. A cell
      // that spans rows needs air after it, or its output runs straight into
      // the next call's verb; and speech after machinery always gets a break.
      const visibleLines =
        !revealAll && !item.expanded && this.registry.expandedByDefault(item.info)
          ? item.rendered.lines.slice(0, 1)
          : revealAll
            ? this.registry.render({ ...item.info, expanded: true }, this.ctx)
            : item.rendered.lines;
      const next = this.transcript[index + 1];
      const previous = this.transcript[index - 1];
      const primaryResult = this.registry.expandedByDefault(item.info);
      const startsSubagentRun =
        isSubagentTool(item) &&
        !isSubagentTool(previous) &&
        (previous?.kind === "tool" || (previous?.kind === "lines" && previous.lines.at(-1) !== ""));
      const leadingBreak =
        (primaryResult && previous?.kind === "lines" && previous.lines.at(-1) !== "") ||
        startsSubagentRun
          ? [""]
          : [];
      const separated =
        next !== undefined &&
        (next.kind === "user" || next.kind === "assistant" ? true : visibleLines.length > 1);
      const lines = this.disclosureLines(
        visibleLines,
        revealAll || item.expanded,
        selectedId === item.id,
      );
      return [...leadingBreak, ...lines, ...(primaryResult || separated ? [""] : [])];
    });
    const rows = this.toTerminalRows(logical);
    if (selectedId === undefined && !revealAll) {
      this.transcriptCache = {
        version: this.transcriptVersion,
        width: this.options.width,
        rows,
      };
    }
    return rows;
  }

  // The live activity and composer region, rebuilt from state on every paint.
  private renderManaged(): string[] {
    const { width, depth } = this.ctx;
    const lines: string[] = [];
    const composerLines: string[] = [];
    const composerWidth = composerContentWidth(width);
    const height = this.options.height ?? 24;

    // Live region: streaming assistant text and running tool cells, so a long
    // turn is never a frozen screen with only a spinner.
    if (this.streaming && this.streaming.trim().length > 0) lines.push(...this.streamingRows());
    const backgroundPending: PendingTool[] = [];
    let hasLiveSubagent = false;
    let previousWasLiveSubagent = false;
    const renderPending = (pending: PendingTool): string[] => {
      const rendered = this.registry.render(
        {
          toolName: pending.toolName,
          args: pending.args,
          running: pending.running === true,
          elapsedMs:
            pending.startedAt === undefined ? 0 : Math.max(0, Date.now() - pending.startedAt),
          argsStreaming: pending.argsStreaming === true,
          expanded: false,
          // A backgrounded command keeps its start result while it runs, so
          // the row can name the task it is waiting on.
          ...(pending.taskId !== undefined && pending.result ? { result: pending.result } : {}),
          ...(pending.progress !== undefined ? { progress: pending.progress } : {}),
        },
        this.ctx,
      );
      if (this.canMoveToBackground(pending) && rendered[0] !== undefined) {
        const hint = styleText(`${GLYPHS.separator} ctrl+z background`, { dim: true }, depth);
        const room = width - stringWidth(stripAnsi(hint)) - 1;
        const header =
          stringWidth(stripAnsi(rendered[0])) > room
            ? truncateToWidth(rendered[0], room)
            : rendered[0];
        rendered[0] = `${header} ${hint}`;
      }
      const task = pending.taskId ? this.backgroundTasks.get(pending.taskId) : undefined;
      const output = task
        ? [...task.tail, ...(task.partial.length > 0 ? [task.partial] : [])].slice(
            -TASK_LIVE_TAIL_LINES,
          )
        : pending.output.display(4);
      for (const line of output) {
        if (line.trim().length > 0) rendered.push(...toolOutputCell(line, this.ctx));
      }
      return rendered;
    };
    for (const pending of this.pendingTools.values()) {
      if (this.mode === "activity" && this.isPendingActivity(pending)) {
        continue;
      }
      if (pending.taskId !== undefined || pending.subagentId !== undefined) {
        backgroundPending.push(pending);
      } else {
        const liveSubagent = SUBAGENT_TOOL_NAMES.has(pending.toolName);
        if (liveSubagent && !previousWasLiveSubagent && lines.at(-1) !== "") lines.push("");
        if (liveSubagent) hasLiveSubagent = true;
        lines.push(...renderPending(pending));
        previousWasLiveSubagent = liveSubagent;
      }
    }
    if (backgroundPending.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(
        MARGIN +
          styleText(
            `${GLYPHS.ruleOpen} background ${GLYPHS.separator} ${backgroundPending.length}`,
            { dim: true },
            depth,
          ),
      );
      for (const [index, pending] of backgroundPending.entries()) {
        if (index > 0) lines.push(MARGIN + styleText(GLYPHS.rule, { dim: true }, depth));
        lines.push(...renderPending(pending));
      }
      lines.push(MARGIN + styleText(GLYPHS.ruleClose, { dim: true }, depth), "");
    }
    if (hasLiveSubagent && lines.at(-1) !== "") lines.push("");
    if (this.compacting && this.compactionStage && this.mode !== "activity") {
      if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
      lines.push(
        compactionProgressRow(
          this.compactionState(),
          this.view.compactionPercent,
          this.spinner.frameIndex,
          this.ctx,
        ),
        "",
      );
    }

    const visiblePending = this.pendingInputs.slice(-PENDING_INPUT_ROWS);
    const hiddenPending = this.pendingInputs.length - visiblePending.length;
    if (hiddenPending > 0) {
      composerLines.push(
        MARGIN +
          styleText(
            `… ${hiddenPending} earlier queued input${hiddenPending === 1 ? "" : "s"}`,
            { dim: true },
            depth,
          ),
      );
    }
    for (const [index, pending] of visiblePending.entries()) {
      composerLines.push(
        ...queuedInputPreview(
          pending.kind,
          pending.text,
          composerWidth,
          depth,
          index === visiblePending.length - 1 && this.options.callbacks.onEditQueued !== undefined,
        ),
      );
    }

    if (this.mode === "approval" && this.approvals[0]) {
      const approval = this.approvals[0];
      const request = approval.request;
      const preview = request.preview;
      composerLines.push(
        ...approvalOverlay(
          {
            title: `${approval.source === "side" ? "side · " : ""}${request.description}`,
            ...(preview?.kind === "diff"
              ? {
                  diff: {
                    path: preview.file.path,
                    added: preview.file.added,
                    removed: preview.file.removed,
                    lines: diffLinesFromHunks(preview.file.hunks),
                  },
                }
              : preview?.kind === "fields"
                ? { sections: preview.sections }
                : {
                    preview: preview?.kind === "text" ? preview.lines : [request.pattern],
                  }),
            maxPreviewRows: Math.max(3, Math.min(12, height - 8)),
            selectedIndex: this.approvalIndex,
          },
          composerWidth,
          depth,
        ),
      );
    } else {
      if (this.mode === "picker" && this.picker) {
        const query =
          this.picker.filterable && this.pickerQuery
            ? ` ${GLYPHS.separator} ${this.pickerQuery}`
            : "";
        const remove = this.picker.onDelete
          ? ` ${GLYPHS.separator} ${this.pickerDeleteValue ? "del again confirm" : "del delete"}`
          : "";
        const back = this.picker.onBack ? ` ${GLYPHS.separator} ← back` : "";
        composerLines.push(
          MARGIN + styleText(`${this.picker.title}${query}${remove}${back}`, { bold: true }, depth),
        );
        composerLines.push(...this.commandList.render(composerWidth, depth));
      } else if (this.mode === "prompt" && this.prompt) {
        composerLines.push(MARGIN + styleText(this.prompt.title, { bold: true }, depth));
        composerLines.push(
          ...(this.prompt.secret
            ? this.promptEditor.renderMasked(composerWidth, depth)
            : this.promptEditor.render(composerWidth, depth)),
        );
      } else if (this.mode === "activity" && this.activitySearch?.showing) {
        composerLines.push(
          ...this.activitySearch.editor.render(composerWidth, depth, this.activitySearch.editing, {
            marker: styleText("/", { accent: true, bold: true }, depth),
          }),
        );
      } else {
        composerLines.push(
          ...this.editor.render(
            composerWidth,
            depth,
            this.mode !== "activity",
            this.isShellMode
              ? {
                  marker: styleText("$", { toolExec: true, bold: true }, depth),
                  firstLineHiddenPrefix: 1,
                }
              : {},
          ),
        );
        if (this.mode === "select" || this.mode === "mention") {
          composerLines.push(...this.commandList.render(composerWidth, depth));
        }
      }
    }

    const composerTitle =
      this.mode === "activity" && this.activitySearch?.showing
        ? styleText("search transcript", { accent: true, bold: true }, depth)
        : this.isShellMode
          ? styleText("shell", { toolExec: true, bold: true }, depth)
          : undefined;
    if (this.mode === "activity" && lines.at(-1) !== "") lines.push("");
    lines.push(...composerBox(composerLines, width, depth, composerTitle));

    const toolHint = "ctrl+o";
    const search = this.activitySearch;
    const activityHint =
      search?.showing && search.editing
        ? "type query · enter search · esc cancel"
        : search?.showing
          ? `${search.matches.length === 0 ? "no matches" : `${search.matchIndex + 1}/${search.matches.length}`} ${GLYPHS.separator} n/N next/previous ${GLYPHS.separator} / new search ${GLYPHS.separator} esc close search`
          : this.stopArmedFor
            ? `x again to stop ${GLYPHS.separator} other keys cancel`
            : `${this.selectedBackgroundCandidate() ? `b background ${GLYPHS.separator} ` : ""}${this.stoppableBackground() && this.options.callbacks.onStopBackground ? `x stop ${GLYPHS.separator} ` : ""}↑↓ select ${GLYPHS.separator} pgup/pgdn jump ${GLYPHS.separator} →/enter expand ${GLYPHS.separator} ← collapse ${GLYPHS.separator} / search ${GLYPHS.separator} ctrl+o/esc close`;
    if (this.running) {
      const elapsed = formatDuration(Date.now() - this.runStartedAt);
      lines.push(
        `${MARGIN}${this.spinner.render(depth)}${styleText(
          this.mode === "activity"
            ? ` ${elapsed} ${GLYPHS.separator} transcript review`
            : this.compacting
              ? ` ${elapsed} ${GLYPHS.separator} enter queue ${GLYPHS.separator} esc cancel`
              : ` ${elapsed} ${GLYPHS.separator} enter steer ${GLYPHS.separator} tab follow-up ${GLYPHS.separator} esc/ctrl+c interrupt ${GLYPHS.separator} ${toolHint}`,
          { dim: true },
          depth,
        )}`,
      );
    } else if (this.view.awaitingUser) {
      lines.push(
        `${MARGIN}${styleText(`◆ ${this.view.awaitingUser}`, { toolMutate: true }, depth)}${styleText(
          ` ${GLYPHS.separator} reply when done`,
          { dim: true },
          depth,
        )}`,
      );
    }
    const hint =
      this.mode === "activity"
        ? activityHint
        : this.running
          ? undefined
          : this.ctrlCPending
            ? "press ctrl+c again to exit"
            : this.isShellMode
              ? `enter run ${GLYPHS.separator} esc cancel`
              : `${toolHint} ${GLYPHS.separator} think ${this.thinkingLevel}${this.view.permissionMode ? "" : ` ${GLYPHS.separator} ctrl+t`}`;
    lines.push(
      ...footer(
        {
          ...this.footerData,
          ...(hint ? { hint } : {}),
          ...(this.mode !== "activity" && this.view.permissionMode
            ? { permissionMode: this.view.permissionMode }
            : {}),
        },
        width,
        depth,
      ),
    );
    return lines;
  }

  private pendingActivityRows(selectedId?: string): string[] {
    const logical: string[] = [];
    for (const pending of this.pendingTools.values()) {
      if (!this.isPendingActivity(pending)) continue;
      const task = pending.taskId ? this.backgroundTasks.get(pending.taskId) : undefined;
      const lines = this.registry.render(
        {
          toolName: pending.toolName,
          args: pending.args,
          running: true,
          elapsedMs:
            pending.startedAt === undefined ? 0 : Math.max(0, Date.now() - pending.startedAt),
          argsStreaming: pending.argsStreaming === true,
          expanded: task ? false : pending.expanded,
          ...(pending.result !== undefined ? { result: pending.result } : {}),
          ...(pending.progress !== undefined ? { progress: pending.progress } : {}),
        },
        this.ctx,
      );
      const lineWidth = Math.max(18, this.options.width - 4);
      if (task && pending.expanded) {
        for (const line of expandedTaskOutputLines(task)) {
          lines.push(...toolOutputCell(truncateToWidth(line, lineWidth), this.ctx));
        }
      } else if (pending.expanded && pending.backgroundable && !pending.subagentId) {
        for (const line of pending.output.display(LIVE_TOOL_OUTPUT_LINES)) {
          lines.push(...toolOutputCell(truncateToWidth(line, lineWidth), this.ctx));
        }
      }
      logical.push(...this.disclosureLines(lines, pending.expanded, selectedId === pending.id));
    }
    return this.toTerminalRows(logical);
  }

  private isPendingActivity(pending: PendingTool): boolean {
    return (
      pending.running === true &&
      (pending.taskId !== undefined ||
        pending.backgroundable === true ||
        this.registry.supportsLiveExpansion(pending.toolName))
    );
  }

  // A running foreground call the user may move to the background: past the hint
  // delay, not awaiting approval, and in the main conversation (a side conversation
  // has no runtime of its own to take it).
  private canMoveToBackground(pending: PendingTool): boolean {
    return (
      pending.backgroundable === true &&
      pending.running === true &&
      pending.taskId === undefined &&
      pending.subagentId === undefined &&
      this.activeSource === "main" &&
      this.options.callbacks.onBackgroundTools !== undefined &&
      Date.now() - (pending.startedAt ?? Date.now()) >= BACKGROUND_HINT_MS &&
      !this.approvals.some((item) => item.request.toolCallId === pending.id)
    );
  }

  private backgroundCandidates(): string[] {
    return [...this.pendingTools.values()]
      .filter((pending) => this.canMoveToBackground(pending))
      .map((pending) => pending.id);
  }

  private selectedBackgroundCandidate(): string | undefined {
    if (this.mode !== "activity") return undefined;
    const node = this.activityNodes().find((candidate) => candidate.id === this.activitySelection);
    return node && "pending" in node && this.canMoveToBackground(node.pending)
      ? node.pending.id
      : undefined;
  }

  private streamingRows(): string[] {
    if (!this.streaming) return [];
    const height = this.options.height ?? 24;
    const cached = this.streamingCache;
    if (
      cached?.text === this.streaming &&
      cached.width === this.options.width &&
      cached.height === height
    ) {
      return cached.rows;
    }
    const maxChars = Math.max(
      MIN_STREAMING_PREVIEW_CHARS,
      Math.min(MAX_STREAMING_PREVIEW_CHARS, this.options.width * height * STREAMING_VIEWPORTS),
    );
    const preview = streamingMarkdownPreview(this.streaming, maxChars);
    const rows = this.toTerminalRows(agentCell(preview.text, this.ctx));
    this.streamingCache = {
      text: this.streaming,
      width: this.options.width,
      height,
      rows,
    };
    return rows;
  }

  private syncBackgroundCount(): void {
    const tasks = [...this.backgroundTasks.values()].filter((task) => !task.exit).length;
    const subagents = [...this.backgroundSubagents.values()].filter((live) => !live.ended).length;
    this.footerData = { ...this.footerData, backgroundTasks: tasks + subagents };
  }

  private stoppableBackground(): string | undefined {
    if (this.mode !== "activity") return undefined;
    const node = this.activityNodes().find((candidate) => candidate.id === this.activitySelection);
    const pending = node && "pending" in node ? node.pending : undefined;
    if (pending?.subagentId) {
      const live = this.backgroundSubagents.get(pending.subagentId);
      return live && !live.ended ? pending.subagentId : undefined;
    }
    if (pending?.taskId) {
      const task = this.backgroundTasks.get(pending.taskId);
      return task && !task.exit ? pending.taskId : undefined;
    }
    return undefined;
  }

  private subagentOwner(subagentId: string): PendingTool | undefined {
    return [...this.pendingTools.values()].find((candidate) => candidate.subagentId === subagentId);
  }

  // An attachment replays a running subagent after the transcript already
  // holds its completed start row; that row becomes live again.
  private adoptRestoredSubagentOwner(subagentId: string): void {
    if (this.subagentOwner(subagentId)) return;
    const owns = (info: ToolRenderInfo) =>
      backgroundSubagentDetails(info.result?.details)?.subagentId === subagentId;
    for (let index = this.transcript.length - 1; index >= 0; index--) {
      const item = this.transcript[index];
      let tool: { id: string; info: ToolRenderInfo; expanded: boolean } | undefined;
      if (item?.kind === "tool" && owns(item.info)) {
        this.transcript.splice(index, 1);
        tool = item;
      } else if (item?.kind === "activity") {
        const toolIndex = item.tools.findIndex((candidate) => owns(candidate.info));
        if (toolIndex === -1) continue;
        [tool] = item.tools.splice(toolIndex, 1);
        if (item.tools.length === 0) this.transcript.splice(index, 1);
      } else continue;
      if (!tool) return;
      this.pendingTools.set(tool.id, {
        id: tool.id,
        ...tool.info,
        running: true,
        expanded: tool.expanded,
        output: new LiveToolOutput(),
        subagentId,
        startedAt: Date.now(),
      });
      this.transcriptVersion++;
      this.transcriptCache = undefined;
      return;
    }
  }

  // A resumed transcript shows a background subagent's start row with the
  // result its completion record carried, as the live view had shown it.
  private restoreSubagentResult(details: unknown): void {
    if (typeof details !== "object" || details === null) return;
    const record = details as {
      type?: unknown;
      toolCallId?: unknown;
      status?: unknown;
      content?: unknown;
      result?: unknown;
    };
    if (
      record.type !== "subagent-background-result" ||
      typeof record.toolCallId !== "string" ||
      !Array.isArray(record.content)
    ) {
      return;
    }
    const upgrade = (info: ToolRenderInfo): ToolRenderInfo | undefined =>
      info.result && backgroundSubagentDetails(info.result.details)
        ? {
            ...info,
            result: {
              ...info.result,
              content: record.content as NonNullable<ToolRenderInfo["result"]>["content"],
              isError: record.status !== "done",
              ...(record.result !== undefined ? { details: record.result } : {}),
            },
          }
        : undefined;
    for (const item of this.transcript) {
      if (item.kind === "tool" && item.id === record.toolCallId) {
        const info = upgrade(item.info);
        if (!info) return;
        item.info = info;
        delete item.rendered;
      } else if (item.kind === "activity") {
        const tool = item.tools.find((candidate) => candidate.id === record.toolCallId);
        const info = tool && upgrade(tool.info);
        if (!tool || !info) continue;
        tool.info = info;
        delete tool.rendered;
      } else continue;
      this.transcriptVersion++;
      this.transcriptCache = undefined;
      return;
    }
  }

  private completeBackgroundSubagent(subagentId: string): string[] | undefined {
    const event = this.backgroundSubagents.get(subagentId)?.ended;
    const owner = this.subagentOwner(subagentId);
    if (!event || !owner?.result) return undefined;
    this.backgroundSubagents.delete(subagentId);
    this.pendingTools.delete(owner.id);
    const info: ToolRenderInfo = {
      toolName: owner.toolName,
      args: owner.args,
      result: {
        ...owner.result,
        content: event.content,
        isError: event.status !== "done",
        ...(event.details !== undefined ? { details: event.details } : {}),
      },
    };
    const lines = this.registry.render(info, this.ctx);
    this.pushTool(owner.id, info, lines, owner.expanded ? true : undefined);
    return lines;
  }

  private adoptRestoredBackgroundOwner(taskId: string): void {
    if ([...this.pendingTools.values()].some((candidate) => candidate.taskId === taskId)) return;
    for (let index = this.transcript.length - 1; index >= 0; index--) {
      const item = this.transcript[index];
      if (item?.kind === "tool") {
        if (backgroundTaskDetails(item.info.result?.details)?.taskId !== taskId) continue;
        this.transcript.splice(index, 1);
        this.pendingTools.set(item.id, {
          id: item.id,
          ...item.info,
          running: true,
          expanded: item.expanded,
          output: new LiveToolOutput(),
          taskId,
          startedAt: Date.now(),
        });
        this.transcriptVersion++;
        this.transcriptCache = undefined;
        return;
      }
      if (item?.kind !== "activity") continue;
      const toolIndex = item.tools.findIndex(
        (tool) => backgroundTaskDetails(tool.info.result?.details)?.taskId === taskId,
      );
      if (toolIndex === -1) continue;
      const [tool] = item.tools.splice(toolIndex, 1);
      if (!tool) return;
      if (item.tools.length === 0) this.transcript.splice(index, 1);
      this.pendingTools.set(tool.id, {
        id: tool.id,
        ...tool.info,
        running: true,
        expanded: tool.expanded,
        output: new LiveToolOutput(),
        taskId,
        startedAt: Date.now(),
      });
      this.transcriptVersion++;
      this.transcriptCache = undefined;
      return;
    }
  }

  private completeBackgroundTask(taskId: string): string[] | undefined {
    const task = this.backgroundTasks.get(taskId);
    const event = task?.exit;
    const owner = [...this.pendingTools.values()].find((candidate) => candidate.taskId === taskId);
    if (!task || !event || !owner?.result) return undefined;
    this.backgroundTasks.delete(taskId);
    this.pendingTools.delete(owner.id);
    const info: ToolRenderInfo = {
      toolName: owner.toolName,
      args: owner.args,
      result: {
        ...owner.result,
        content: [{ type: "text", text: taskOutputText(task) }],
        isError: event.status === "killed" || event.exitCode !== 0,
        details: {
          ...(typeof owner.result.details === "object" && owner.result.details !== null
            ? owner.result.details
            : {}),
          exitCode: event.exitCode,
          durationMs: Date.now() - task.startedAt,
          ...(event.status === "killed" ? { killed: true } : {}),
        },
      },
    };
    const lines = this.registry.render(info, this.ctx);
    this.pushTool(owner.id, info, lines, owner.expanded ? true : undefined);
    return lines;
  }

  private pushTool(
    id: string,
    info: ToolRenderInfo,
    renderedLines?: string[],
    expandedOverride?: boolean,
  ): void {
    const location = info.result ? this.registry.location(info) : undefined;
    if (location) this.footerData = { ...this.footerData, cwd: location };
    const activityKind = this.registry.activityKind(info);
    const expanded = expandedOverride ?? this.registry.expandedByDefault(info);
    if (!activityKind) {
      this.pushTranscript({
        kind: "tool",
        id,
        info,
        expanded,
        ...(renderedLines && !expanded
          ? {
              rendered: {
                width: this.options.width,
                expanded: false,
                superseded: false,
                lines: renderedLines,
              },
            }
          : {}),
      });
      return;
    }

    const tool: ActivityTool = {
      id,
      info,
      expanded,
      ...(renderedLines && !expanded
        ? {
            rendered: {
              width: this.options.width,
              expanded: false,
              lines: renderedLines,
            },
          }
        : {}),
    };
    const group = this.registry.activityGroup(info);
    const last = this.transcript.at(-1);
    const thinking =
      last?.kind === "assistant" &&
      !hasAssistantText(last.message) &&
      this.registry.groupsAcrossThinking(info)
        ? last
        : undefined;
    const previous = thinking ? this.transcript.at(-2) : last;
    if (
      previous?.kind === "activity" &&
      previous.activityKind === activityKind &&
      previous.group === group
    ) {
      if (thinking) {
        this.transcript.splice(this.transcript.indexOf(thinking), 1);
        tool.thinking = thinking.message;
      }
      previous.tools.push(tool);
      this.transcriptVersion++;
      this.transcriptCache = undefined;
      return;
    }
    this.pushTranscript({
      kind: "activity",
      id: `activity:${id}`,
      activityKind,
      ...(group ? { group } : {}),
      tools: [tool],
      expanded: false,
    });
  }

  private disclosureLines(lines: string[], expanded: boolean, selected: boolean): string[] {
    if (lines.length === 0) return [];
    const marker = styleText(
      selected ? "❯" : expanded ? "⌄" : "›",
      {
        ...(selected ? { accent: true, bold: true } : { dim: true }),
      },
      this.options.depth,
    );
    const [first = "", ...rest] = lines;
    const body = first.startsWith(MARGIN) ? first.slice(MARGIN.length) : first;
    const visibleBody = stripAnsi(body);
    const hasHeaderRail = [GLYPHS.rule, GLYPHS.ruleOpen].some((glyph) =>
      visibleBody.startsWith(`${glyph} `),
    );
    const content = hasHeaderRail ? body.slice(rawOffsetAtVisible(body, 2)) : body;
    return [`${MARGIN}${marker} ${content}`, ...rest];
  }

  private activitySummary(item: Extract<TranscriptItem, { kind: "activity" }>): string {
    return this.registry.activitySummary(
      item.activityKind,
      item.tools.map((tool) => tool.info),
      this.options.depth,
    );
  }

  private renderActivityTool(
    tool: ActivityTool,
    activityKind: ActivityKind,
    selected: boolean,
    reveal = false,
  ): string[] {
    const expanded = reveal || tool.expanded;
    if (tool.rendered?.width !== this.options.width || tool.rendered.expanded !== expanded) {
      tool.rendered = {
        width: this.options.width,
        expanded,
        lines: this.registry.render({ ...tool.info, expanded }, this.ctx),
      };
    }
    const lines = [...tool.rendered.lines];
    if (activityKind === "edit" && lines.length > 0) {
      const diff = (tool.info.result?.details as { diff?: CheckpointDiffFile } | undefined)?.diff;
      if (diff) {
        lines[0] = `${lines[0]} ${styleText(`+${diff.added}`, { green: true }, this.options.depth)} ${styleText(`-${diff.removed}`, { red: true }, this.options.depth)}`;
      }
    }
    return this.disclosureLines(expanded ? lines : lines.slice(0, 1), expanded, selected);
  }

  private renderActivity(
    item: Extract<TranscriptItem, { kind: "activity" }>,
    selectedId?: string,
    revealAll = false,
  ): string[] {
    if (item.tools.length === 1) {
      const tool = item.tools[0] as ActivityTool;
      return this.renderActivityTool(tool, item.activityKind, selectedId === tool.id, revealAll);
    }
    const expanded = revealAll || item.expanded;
    const marker = styleText(
      selectedId === item.id ? "❯" : expanded ? "⌄" : "›",
      {
        ...(selectedId === item.id ? { accent: true, bold: true } : { dim: true }),
      },
      this.options.depth,
    );
    const summary = `${MARGIN}${marker} ${styleText(this.activitySummary(item), { bold: true }, this.options.depth)}`;
    if (!expanded) return [summary];
    return [
      summary,
      ...item.tools.flatMap((tool) => [
        ...(tool.thinking ? this.assistantRows(tool.thinking, revealAll) : []),
        ...this.renderActivityTool(tool, item.activityKind, selectedId === tool.id, revealAll),
      ]),
    ];
  }

  private activityNodes(): ActivityNode[] {
    const nodes: ActivityNode[] = [];
    for (const item of this.transcript) {
      if (item.kind === "tool") nodes.push({ id: item.id, item });
      if (item.kind !== "activity") continue;
      if (item.tools.length === 1) {
        const tool = item.tools[0] as ActivityTool;
        nodes.push({ id: tool.id, item, tool });
      } else {
        nodes.push({ id: item.id, item });
        if (item.expanded) {
          for (const tool of item.tools) nodes.push({ id: tool.id, item, tool });
        }
      }
    }
    for (const pending of this.pendingTools.values()) {
      if (this.isPendingActivity(pending)) nodes.push({ id: pending.id, pending });
    }
    return nodes;
  }

  private pushTranscript(item: TranscriptItem): void {
    this.transcript.push(item);
    this.transcriptVersion++;
    this.transcriptCache = undefined;
  }

  private clearPendingSubmissions(): void {
    const retained = this.transcript.filter(
      (item) => item.kind !== "user" || item.pending !== true,
    );
    if (retained.length === this.transcript.length) return;
    this.transcript = retained;
    this.transcriptVersion++;
    this.transcriptCache = undefined;
  }

  private submitUser(text: string): boolean | undefined {
    const pending: TranscriptItem = { kind: "user", text, pending: true };
    this.pushTranscript(pending);
    try {
      const accepted = this.options.callbacks.onSubmit(text);
      if (accepted === false && pending.pending === true) this.removePendingSubmission(pending);
      return accepted === false ? false : undefined;
    } catch (error) {
      if (pending.pending === true) this.removePendingSubmission(pending);
      throw error;
    }
  }

  private removePendingSubmission(pending: TranscriptItem): void {
    const index = this.transcript.indexOf(pending);
    if (index === -1) return;
    this.transcript.splice(index, 1);
    this.transcriptVersion++;
    this.transcriptCache = undefined;
  }

  private assistantRows(message: AssistantMessage, revealThinking = false): string[] {
    const lines: string[] = [];
    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking.trim()) {
        lines.push(...thinkingCell(block.thinking, this.ctx, revealThinking));
      } else if (block.type === "text" && block.text.trim()) {
        lines.push(...this.toTerminalRows(agentCell(block.text, this.ctx)));
      }
    }
    return lines;
  }

  private toTerminalRows(lines: string[]): string[] {
    return terminalRows(lines, this.options.width);
  }

  private fitToViewport(lines: string[]): string[] {
    const limit = Math.max(1, (this.options.height ?? 24) - 1);
    if (lines.length <= limit) return lines;
    if (limit === 1) return lines.slice(-1);

    const cursor = lines.findIndex((line) => line.includes(BLOCK_CURSOR_ON));
    const pinnedStart = lines.lastIndexOf(
      composerBoxBottom(this.options.width, this.options.depth),
    );
    if (cursor >= 0 && pinnedStart > cursor) {
      const pinned = lines.slice(pinnedStart);
      const scrollLimit = limit - pinned.length;
      if (scrollLimit > 0) {
        let contentLimit = scrollLimit;
        let start = 0;
        let end = 0;
        let showAbove = false;
        let showBelow = false;

        for (let pass = 0; pass < 3; pass++) {
          const maxStart = Math.max(0, pinnedStart - contentLimit);
          start = Math.min(Math.max(0, cursor - Math.floor(contentLimit / 2)), maxStart);
          end = Math.min(pinnedStart, start + contentLimit);
          const wantsAbove = start > 0;
          const wantsBelow = end < pinnedStart;
          const markerLimit = Math.max(0, scrollLimit - 1);
          showAbove = wantsAbove && markerLimit > 0;
          showBelow = wantsBelow && markerLimit > (showAbove ? 1 : 0);
          contentLimit = scrollLimit - Number(showAbove) - Number(showBelow);
        }

        return [
          ...(showAbove
            ? [
                MARGIN +
                  styleText(`… ${start} rows above hidden`, { dim: true }, this.options.depth),
              ]
            : []),
          ...lines.slice(start, end),
          ...(showBelow
            ? [
                MARGIN +
                  styleText(
                    `… ${pinnedStart - end} rows below hidden`,
                    { dim: true },
                    this.options.depth,
                  ),
              ]
            : []),
          ...pinned,
        ];
      }
    }

    const hidden = lines.length - limit + 1;
    return [
      MARGIN + styleText(`… ${hidden} rows above hidden`, { dim: true }, this.options.depth),
      ...lines.slice(-(limit - 1)),
    ];
  }

  private toggleActivityNode(expanded?: boolean): void {
    const node = this.activityNodes().find((candidate) => candidate.id === this.activitySelection);
    if (!node) return;
    if ("pending" in node) node.pending.expanded = expanded ?? !node.pending.expanded;
    else if (node.tool) node.tool.expanded = expanded ?? !node.tool.expanded;
    else if (node.item.kind === "activity") {
      node.item.expanded = expanded ?? !node.item.expanded;
    } else if (node.item.kind === "tool") {
      node.item.expanded = expanded ?? !node.item.expanded;
    }
    this.transcriptVersion++;
    this.transcriptCache = undefined;
  }

  private openActivity(): void {
    const nodes = this.activityNodes();
    const latest = nodes.at(-1);
    if (this.transcript.length === 0 && nodes.length === 0) return;
    this.activitySelection = latest?.id;
    this.activitySearch = undefined;
    this.mode = "activity";
  }

  private closeActivity(): void {
    this.activitySearch = undefined;
    this.mode = this.approvals.length > 0 ? "approval" : "composing";
  }

  private startActivitySearch(): void {
    const existing = this.activitySearch;
    if (existing) {
      existing.showing = true;
      existing.editing = true;
      existing.editor.setText(existing.query);
      return;
    }
    this.activitySearch = {
      editor: new Editor(),
      editing: true,
      showing: true,
      query: "",
      rows: [],
      matches: [],
      matchIndex: 0,
      transcriptVersion: -1,
      width: this.options.width,
    };
  }

  private refreshActivitySearch(search: ActivitySearch, reset = false): void {
    const previous = search.matches[search.matchIndex];
    const rows = this.transcriptRows(undefined, true);
    const query = search.query.toLowerCase();
    const matches: ActivitySearchMatch[] = [];
    for (const [row, line] of rows.entries()) {
      const visible = stripAnsi(line).toLowerCase();
      let start = 0;
      while (start <= visible.length - query.length) {
        const found = visible.indexOf(query, start);
        if (found === -1) break;
        matches.push({ row, start: found, length: query.length });
        start = found + Math.max(1, query.length);
      }
    }
    search.rows = rows;
    search.matches = matches;
    search.transcriptVersion = this.transcriptVersion;
    search.width = this.options.width;
    if (reset || !previous || matches.length === 0) {
      search.matchIndex = 0;
      return;
    }
    let closest = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (const [index, match] of matches.entries()) {
      const candidate =
        Math.abs(match.row - previous.row) * this.options.width +
        Math.abs(match.start - previous.start);
      if (candidate < distance) {
        closest = index;
        distance = candidate;
      }
    }
    search.matchIndex = closest;
  }

  private submitActivitySearch(): void {
    const search = this.activitySearch;
    if (!search) return;
    const query = search.editor.text.trim();
    if (!query) return;
    search.query = query;
    search.editing = false;
    this.refreshActivitySearch(search, true);
  }

  private moveActivitySearch(offset: number): void {
    const search = this.activitySearch;
    if (!search || search.editing || search.matches.length === 0) return;
    search.matchIndex =
      (search.matchIndex + offset + search.matches.length) % search.matches.length;
  }

  private highlightSearchMatch(line: string, match: ActivitySearchMatch): string {
    const start = rawOffsetAtVisible(line, match.start);
    const end = rawOffsetAtVisible(line, match.start + match.length);
    const highlighted = `${line.slice(0, start)}${styleText(
      line.slice(start, end),
      { accent: true, bold: true, underline: true },
      this.options.depth,
    )}${line.slice(end)}`;
    const marker = styleText("❯", { accent: true, bold: true }, this.options.depth);
    return highlighted.startsWith(MARGIN)
      ? `${marker} ${highlighted.slice(MARGIN.length)}`
      : `${marker} ${highlighted}`;
  }

  private handleActivityKey(key: Key): void {
    const search = this.activitySearch;
    if (search?.showing && search.editing) {
      if (key.name === "escape") {
        this.activitySearch = undefined;
        return;
      }
      if (key.name === "return") {
        this.submitActivitySearch();
        return;
      }
      if (key.name === "backspace") {
        search.editor.backspace();
        return;
      }
      if (["left", "right", "home", "end"].includes(key.name)) {
        search.editor.move(key.name as "left" | "right" | "home" | "end");
        return;
      }
      if (key.name === "space") {
        search.editor.insert(" ");
        return;
      }
      if (!key.ctrl && !key.alt && key.text) search.editor.insert(key.text);
      return;
    }
    if (search?.showing) {
      if (key.name === "escape") {
        search.showing = false;
        return;
      }
      if (key.text === "/") {
        this.startActivitySearch();
        return;
      }
      if (key.text === "n" || key.text === "N") {
        this.moveActivitySearch(key.shift || key.text === "N" ? -1 : 1);
      }
      return;
    }
    if (key.name === "escape") {
      this.closeActivity();
      return;
    }
    if (key.text === "/") {
      this.startActivitySearch();
      return;
    }
    if (["up", "down", "pageup", "pagedown", "return", "right", "left"].includes(key.name)) {
      this.activitySearch = undefined;
    }
    const nodes = this.activityNodes();
    let index = nodes.findIndex((node) => node.id === this.activitySelection);
    if (index < 0) index = Math.max(0, nodes.length - 1);
    const armed = this.stopArmedFor;
    this.stopArmedFor = undefined;
    if (key.text === "b" && !key.ctrl && !key.alt) {
      const id = this.selectedBackgroundCandidate();
      if (id) this.options.callbacks.onBackgroundTools?.([id]);
      return;
    }
    if (key.text === "x" && !key.ctrl && !key.alt) {
      const id = this.stoppableBackground();
      if (!id || !this.options.callbacks.onStopBackground) return;
      if (armed === id) this.options.callbacks.onStopBackground(id);
      else this.stopArmedFor = id;
      return;
    }
    if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
      const page = Math.max(1, (this.options.height ?? 24) - 6);
      const offset =
        key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -page : page;
      const next = Math.max(0, Math.min(nodes.length - 1, index + offset));
      this.activitySelection = nodes[next]?.id;
      return;
    }
    if (key.name === "return" || key.name === "right") {
      this.toggleActivityNode(true);
      return;
    }
    if (key.name !== "left") return;
    const node = nodes[index];
    if (!node) return;
    const isExpanded =
      "pending" in node
        ? node.pending.expanded
        : node.tool
          ? node.tool.expanded
          : node.item.kind === "activity" || node.item.kind === "tool"
            ? node.item.expanded
            : false;
    if (isExpanded) {
      this.toggleActivityNode(false);
      return;
    }
    if (
      !("pending" in node) &&
      node.tool &&
      node.item.kind === "activity" &&
      node.item.tools.length > 1
    ) {
      this.activitySelection = node.item.id;
    }
  }

  // Mirrors Escape: aborts an active run rather than killing the session
  // outright. When idle, clears composer text like a normal interrupt (pi's
  // behavior); an empty composer arms a "press again" exit window instead of
  // exiting immediately, so a single stray keystroke can't drop in-flight work.
  private handleCtrlC(): void {
    if (this.running) {
      this.options.callbacks.onAbort();
      this.ctrlCArmedAt = 0;
      return;
    }
    if (this.mode === "composing" && this.editor.text.length > 0) {
      this.editor.setText("");
      this.ctrlCArmedAt = 0;
      return;
    }
    if (this.ctrlCPending) {
      this.options.callbacks.onExit();
      return;
    }
    this.ctrlCArmedAt = Date.now();
  }

  handleInput(event: InputEvent): void {
    // Any input other than the confirming Ctrl+C disarms the exit window.
    if (
      this.ctrlCArmedAt !== 0 &&
      !(event.type === "key" && event.key.ctrl && event.key.name === "c")
    ) {
      this.ctrlCArmedAt = 0;
    }
    if (event.type === "paste") {
      if (this.mode === "activity") {
        if (this.activitySearch?.editing) {
          this.activitySearch.editor.insert(event.text.replace(/[\r\n]+/g, " "));
        }
        return;
      }
      if (this.mode === "prompt") {
        this.promptEditor.insert(event.text.replace(/[\r\n]+/g, ""));
        return;
      }
      if (this.mode === "picker" && this.picker?.filterable) {
        this.pickerQuery += event.text.replace(/\s+/g, " ");
        this.pickerDeleteValue = undefined;
        this.refreshPicker();
        return;
      }
      // A paste never submits, however many newlines it contains.
      this.editor.insert(event.text);
      return;
    }
    if (event.type !== "key") return;
    const key = event.key;

    if (key.ctrl && key.name === "c") {
      this.handleCtrlC();
      return;
    }

    if (key.ctrl && key.name === "o") {
      if (this.mode === "activity") this.closeActivity();
      else if (this.mode === "composing") this.openActivity();
      return;
    }

    if (key.ctrl && key.name === "z") {
      const ids = this.backgroundCandidates();
      if (ids.length > 0) this.options.callbacks.onBackgroundTools?.(ids);
      return;
    }

    if (key.ctrl && key.name === "b" && this.side) {
      this.toggleSideConversation();
      return;
    }

    // Ctrl+T cycles thinking depth without leaving the composer.
    if (key.ctrl && key.name === "t") {
      const levels = this.thinkingLevels;
      if (levels.length < 2) return;
      const next = levels[(levels.indexOf(this.thinkingLevel) + 1) % levels.length] as string;
      this.thinkingLevel = next;
      this.options.callbacks.onThinkingChange?.(next);
      return;
    }

    if (key.alt && !key.ctrl && key.name === "t") {
      this.handleLocalCommand(`/${COLLAPSE_COMMAND.label}`);
      return;
    }

    // Shift+Tab cycles permission modes. The mode list itself is
    // profile-owned (the surface decides what "next" means), so this is a
    // bare signal — unlike Ctrl+T, App holds no permission-mode state.
    if (key.shift && key.name === "tab") {
      this.options.callbacks.onCyclePermissionMode?.();
      return;
    }

    if (this.mode === "approval") {
      this.handleApprovalKey(key);
      return;
    }

    if (this.mode === "activity") {
      this.handleActivityKey(key);
      return;
    }

    if (this.mode === "picker") {
      this.handlePickerKey(key);
      return;
    }

    if (this.mode === "prompt") {
      this.handlePromptKey(key);
      return;
    }

    if (this.mode === "select" || this.mode === "mention") {
      if (this.mode === "mention") this.handleMentionKey(key);
      else this.handleSelectKey(key);
      return;
    }

    // Ctrl+J inserts a newline on every terminal — it's a raw control byte
    // (0x0A), not a reported modifier, so unlike Shift/Ctrl/Alt+Enter it needs
    // no terminal protocol support at all.
    if (key.ctrl && key.name === "j") {
      this.editor.newline();
      return;
    }

    switch (key.name) {
      case "escape":
        if (this.running) this.options.callbacks.onAbort();
        else if (this.isShellMode) this.editor.setText("");
        else if (
          this.activeSource === "side" &&
          this.editor.isEmpty &&
          this.approvals.length === 0
        ) {
          this.options.callbacks.onCloseSide?.();
        }
        return;
      case "return": {
        // Two ways to insert a newline instead of submitting. Shift/Ctrl/Alt+Enter
        // work only where the terminal reports the modifier (kitty keyboard
        // protocol / xterm modifyOtherKeys — see terminal.ts). A trailing
        // backslash works on every terminal, needing no modifier reporting: an
        // odd run of backslashes before the cursor is a line continuation, so
        // one backslash is consumed and a newline is inserted.
        if (key.shift || key.ctrl || key.alt) {
          this.editor.newline();
          return;
        }
        const trailingBackslashes = /\\*$/.exec(this.editor.textBeforeCursor)?.[0].length ?? 0;
        if (trailingBackslashes % 2 === 1) {
          this.editor.backspace();
          this.editor.newline();
          return;
        }
        if (this.isShellMode && this.editor.text.slice(1).trim().length === 0) return;
        const text = this.editor.submit();
        if (text.trim().length === 0) return;
        if (text.startsWith("!") && this.options.callbacks.onShell) {
          this.options.callbacks.onShell(text.slice(1).trim());
        } else if (text.startsWith("/")) {
          if (!this.handleLocalCommand(text)) this.options.callbacks.onCommand?.(text);
        } else {
          const queueDuringCompaction =
            this.running && this.compacting && this.options.callbacks.onFollowUp;
          const accepted = queueDuringCompaction
            ? this.options.callbacks.onFollowUp?.(text)
            : this.running && this.options.callbacks.onSteer
              ? this.options.callbacks.onSteer(text)
              : this.submitUser(text);
          if (this.running && accepted !== false) {
            this.pendingInputs.push({ kind: queueDuringCompaction ? "follow-up" : "steer", text });
          }
        }
        return;
      }
      case "tab": {
        if (!this.running || !this.options.callbacks.onFollowUp) return;
        const text = this.editor.submit();
        if (text.trim().length === 0) return;
        if (this.options.callbacks.onFollowUp(text) !== false) {
          this.pendingInputs.push({ kind: "follow-up", text });
        }
        return;
      }
      case "up": {
        if (key.alt) {
          const pending = this.pendingInputs.at(-1);
          if (
            !pending ||
            !this.options.callbacks.onEditQueued ||
            this.options.callbacks.onEditQueued(pending.kind, pending.text) === false
          ) {
            return;
          }
          this.pendingInputs.pop();
          const draft = this.editor.text;
          this.editor.setText(
            [pending.text, draft].filter((part) => part.trim().length > 0).join("\n\n"),
          );
          return;
        }
        if (this.editor.isRecallingHistory) {
          this.editor.recallHistory("up");
          return;
        }
        if (this.editor.isEmpty && this.editor.recallHistory("up")) return;
        this.editor.move("up");
        return;
      }
      case "backspace":
        this.editor.backspace();
        return;
      case "down":
        if (this.editor.isRecallingHistory) {
          this.editor.recallHistory("down");
          return;
        }
        if (this.editor.isEmpty && this.editor.recallHistory("down")) return;
        this.editor.move("down");
        return;
      case "left":
        if (this.editor.isEmpty && this.options.callbacks.onDetach) {
          this.options.callbacks.onDetach();
          return;
        }
        this.editor.move("left");
        return;
      case "right":
      case "home":
      case "end":
        this.editor.move(key.name);
        return;
      case "space":
        this.editor.insert(" ");
        return;
      default:
        if (key.alt || key.ctrl) return;
        if (key.text) {
          this.editor.insert(key.text);
          // "/" at the start of an empty line opens the command popup.
          if (key.text === "/" && this.editor.text === "/") {
            this.openCommandMenu();
          }
          // "@" anywhere opens the file-mention popup.
          if (key.text === "@" && this.options.callbacks.onMentionQuery) {
            // Anchor at the cursor, so a mention typed mid-buffer completes in
            // place instead of eating the rest of the line.
            this.mentionStart = this.editor.offset - 1;
            this.commandList.setItems(this.options.callbacks.onMentionQuery(""));
            this.mode = "mention";
          }
        }
    }
  }

  private handleApprovalKey(key: Key): void {
    const approval = this.approvals[0];
    if (!approval) return;
    const { request, source } = approval;
    if (key.name === "left") {
      this.approvalIndex =
        (this.approvalIndex - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length;
      return;
    }
    if (key.name === "right" || key.name === "tab") {
      this.approvalIndex = (this.approvalIndex + 1) % APPROVAL_OPTIONS.length;
      return;
    }
    if (key.name === "escape") {
      this.options.callbacks.onPermissionReply?.(request.id, "deny", false, source);
      return;
    }
    if (key.name === "return") {
      const option = APPROVAL_OPTIONS[this.approvalIndex];
      const outcome = option === "deny" ? "deny" : "allow";
      this.options.callbacks.onPermissionReply?.(
        request.id,
        outcome,
        option === "always allow",
        source,
      );
    }
  }

  private handlePickerKey(key: Key): void {
    const picker = this.picker;
    if (!picker) return;
    if (key.name === "up" || key.name === "down") {
      this.commandList.move(key.name);
      this.pickerDeleteValue = undefined;
      return;
    }
    if (key.name === "left" && picker.onBack) {
      const onBack = picker.onBack;
      this.picker = undefined;
      this.pickerQuery = "";
      this.pickerDeleteValue = undefined;
      this.mode = "composing";
      onBack();
      return;
    }
    if (key.name === "escape") {
      const onCancel = picker.onCancel;
      this.picker = undefined;
      this.pickerQuery = "";
      this.pickerDeleteValue = undefined;
      this.mode = "composing";
      onCancel?.();
      return;
    }
    if (picker.filterable && key.name === "backspace") {
      this.pickerQuery = [...this.pickerQuery].slice(0, -1).join("");
      this.pickerDeleteValue = undefined;
      this.refreshPicker();
      return;
    }
    if (key.name === "delete" && picker.onDelete) {
      const selected = this.commandList.selected;
      if (!selected) return;
      const value = selected.value ?? selected.label;
      if (this.pickerDeleteValue !== value) {
        this.pickerDeleteValue = value;
        return;
      }
      this.picker = undefined;
      this.pickerQuery = "";
      this.pickerDeleteValue = undefined;
      this.mode = "composing";
      picker.onDelete(value);
      return;
    }
    if (key.name === "return") {
      const selected = this.commandList.selected;
      if (!selected) return;
      this.picker = undefined;
      this.pickerQuery = "";
      this.pickerDeleteValue = undefined;
      this.mode = "composing";
      picker.onChoose(selected.value ?? selected.label);
      return;
    }
    if (picker.filterable && !key.ctrl && !key.alt && key.text) {
      this.pickerQuery += key.text;
      this.pickerDeleteValue = undefined;
      this.refreshPicker();
    }
  }

  private handlePromptKey(key: Key): void {
    const prompt = this.prompt;
    if (!prompt) return;
    if (key.name === "escape") {
      this.prompt = undefined;
      this.promptEditor.setText("");
      this.mode = "composing";
      prompt.onCancel?.();
      return;
    }
    if (key.name === "return") {
      const value = this.promptEditor.text;
      if (!value.trim()) return;
      this.prompt = undefined;
      this.promptEditor.setText("");
      this.mode = "composing";
      prompt.onSubmit(value);
      return;
    }
    if (key.name === "backspace") {
      this.promptEditor.backspace();
      return;
    }
    if (key.name === "left" || key.name === "right" || key.name === "home" || key.name === "end") {
      this.promptEditor.move(key.name);
      return;
    }
    if (key.name === "space") {
      this.promptEditor.insert(" ");
      return;
    }
    if (!key.ctrl && !key.alt && key.text) this.promptEditor.insert(key.text);
  }

  private refreshPicker(selectedValue?: string): void {
    const picker = this.picker;
    if (!picker) return;
    const query = this.pickerQuery.trim();
    if (!query) {
      this.commandList.setItems(picker.items, selectedValue);
      return;
    }
    this.commandList.setItems(
      picker.items
        .map((item, index) => ({
          item,
          index,
          score: fuzzyScore(`${item.label} ${item.description ?? ""}`, query),
        }))
        .filter(
          (candidate): candidate is typeof candidate & { score: number } =>
            candidate.score !== undefined,
        )
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .map((candidate) => candidate.item),
      selectedValue,
    );
  }

  // The `@` popup completes a path into the composer rather than submitting.
  // The `/` popup does the same on tab; see handleSelectKey.
  private handleMentionKey(key: Key): void {
    if (key.name === "up" || key.name === "down") {
      this.commandList.move(key.name);
      return;
    }
    if (key.name === "escape") {
      this.mode = "composing";
      this.mentionStart = -1;
      return;
    }
    if (key.name === "return" || key.name === "tab") {
      const selected = this.commandList.selected;
      if (selected && this.mentionStart >= 0) {
        // Replace just the "@query" span; the unsent suffix is preserved.
        this.editor.spliceBeforeCursor(this.mentionStart, `${selected.label} `);
      }
      this.mode = "composing";
      this.mentionStart = -1;
      return;
    }
    if (key.name === "backspace") {
      this.editor.backspace();
      if (this.editor.offset <= this.mentionStart) {
        this.mode = "composing";
        this.mentionStart = -1;
        return;
      }
      this.refreshMentions();
      return;
    }
    if (key.text) {
      if (key.text === " ") {
        this.editor.insert(" ");
        this.mode = "composing";
        this.mentionStart = -1;
        return;
      }
      this.editor.insert(key.text);
      this.refreshMentions();
    }
  }

  private filterCommands(): void {
    const query = this.editor.text.slice(1).toLowerCase();
    this.commandList.setItems(
      query.length === 0
        ? this.commands
        : this.commands.filter((c) => c.label.toLowerCase().startsWith(query)),
    );
  }

  private handleLocalCommand(command: string): boolean {
    if (command.trim() !== `/${COLLAPSE_COMMAND.label}`) return false;
    let changed = false;
    for (const item of this.transcript) {
      if (item.kind === "tool") {
        changed ||= item.expanded;
        item.expanded = false;
        continue;
      }
      if (item.kind !== "activity") continue;
      changed ||= item.expanded || item.tools.some((tool) => tool.expanded);
      item.expanded = false;
      for (const tool of item.tools) tool.expanded = false;
    }
    for (const pending of this.pendingTools.values()) {
      changed ||= pending.expanded;
      pending.expanded = false;
    }
    if (changed) {
      this.transcriptVersion++;
      this.transcriptCache = undefined;
    }
    return true;
  }

  private refreshMentions(): void {
    const query = this.editor.text.slice(this.mentionStart + 1, this.editor.offset);
    this.commandList.setItems(this.options.callbacks.onMentionQuery?.(query) ?? []);
  }

  private handleSelectKey(key: Key): void {
    if (key.name === "up" || key.name === "down") {
      this.commandList.move(key.name);
      return;
    }
    if (key.name === "escape") {
      this.mode = "composing";
      return;
    }
    // Tab completes into the composer rather than running, so a command that
    // takes arguments has somewhere to type them. The popup closes because its
    // filter is a prefix match on the whole line, which the trailing space and
    // any argument would immediately empty. Mirrors the `@` popup.
    if (key.name === "tab") {
      const selected = this.commandList.selected;
      if (!selected) return;
      this.editor.setText(`/${selected.label} `);
      this.mode = "composing";
      return;
    }
    if (key.name === "return") {
      const typed = this.editor.text;
      const selected = this.commandList.selected;
      this.mode = "composing";
      this.editor.submit();
      // Text the user typed wins when it carries arguments or names a command
      // the popup has filtered away; the highlighted item is only a shortcut.
      const hasArgs = typed.trim().includes(" ");
      const command = hasArgs || !selected ? typed.trim() : `/${selected.label}`;
      if (command.length > 1 && !this.handleLocalCommand(command)) {
        this.options.callbacks.onCommand?.(command);
      }
      return;
    }
    if (key.name === "backspace") {
      this.editor.backspace();
      if (!this.editor.text.startsWith("/")) {
        this.mode = "composing";
        return;
      }
      // Re-filter on the shortened query: deleting a character must widen the
      // list again rather than leaving it stuck on the previous filter.
      this.filterCommands();
      return;
    }
    if (key.text) {
      this.editor.insert(key.text);
      this.filterCommands();
    }
  }
}

function rawOffsetAtVisible(text: string, target: number): number {
  let raw = 0;
  let visible = 0;
  while (raw < text.length && visible < target) {
    if (text[raw] === "\u001b" && text[raw + 1] === "[") {
      raw += 2;
      while (raw < text.length && !/[A-Za-z]/.test(text[raw] ?? "")) raw++;
      if (raw < text.length) raw++;
      continue;
    }
    if (text[raw] === "\u001b" && text[raw + 1] === "]") {
      const bell = text.indexOf("\u0007", raw + 2);
      const stringTerminator = text.indexOf("\u001b\\", raw + 2);
      const end =
        bell === -1
          ? stringTerminator
          : stringTerminator === -1
            ? bell
            : Math.min(bell, stringTerminator);
      if (end === -1) return text.length;
      raw = end + (end === stringTerminator ? 2 : 1);
      continue;
    }
    raw++;
    visible++;
  }
  return raw;
}

function fuzzyScore(value: string, query: string): number | undefined {
  const candidate = value.toLowerCase();
  const needle = query.toLowerCase();
  let position = 0;
  let previous = -2;
  let score = 0;

  for (const char of needle) {
    const found = candidate.indexOf(char, position);
    if (found === -1) return undefined;
    const boundary = found === 0 || /[\s/_.-]/.test(candidate[found - 1] ?? "");
    score += found - previous - 1;
    if (found === previous + 1) score -= 4;
    if (boundary) score -= 3;
    previous = found;
    position = found + 1;
  }

  const contiguous = candidate.indexOf(needle);
  if (contiguous !== -1) score -= 20 - Math.min(contiguous, 10);
  return score;
}
