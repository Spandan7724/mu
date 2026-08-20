import { readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  modelPickerItems,
  type ParsedArgs,
  registerDeclaredRenderers,
  registerProductRenderers,
  renderCheckpointCommand,
  renderDiffCommand,
  resolveCliModel,
} from "@mu/cli-runtime";
import {
  App,
  type ColorDepth,
  CTRL_C_EXIT_WINDOW_MS,
  composerRule,
  detectColorDepth,
  Editor,
  FullScreenRenderer,
  formatCwdForFooter,
  InputDecoder,
  type InputEvent,
  MARGIN,
  RendererRegistry,
  type SelectItem,
  SelectList,
  styleText,
  Terminal,
  truncateToWidth,
  wrapText,
} from "@mu/tui";
import {
  type CheckpointActionData,
  type DiffCommandData,
  ExtensionHost,
  type Profile,
  readAuthFile,
} from "mu";
import cliPackage from "../package.json";
import { dispatchEnvironment, scopeForCurrentProject } from "./agent-supervisor.ts";
import { AgentViewClient } from "./agent-view-client.ts";
import type { AgentViewResponse } from "./agent-view-protocol.ts";
import type { ManagedSessionRecord, ManagedSessionState } from "./agent-view-state.ts";
import { userConfigPath } from "./data.ts";
import { type CodingProductOptions, codingProduct } from "./product.ts";
import { DEFAULT_PROFILE, resolveProfile } from "./profiles.ts";

interface AgentsAppCallbacks {
  dispatch(prompt: string, model: string | undefined): void;
  attach(sessionId: string): void;
  reply(sessionId: string, text: string): void;
  permission(sessionId: string, requestId: string, outcome: "allow" | "deny"): void;
  stop(sessionId: string): void;
  remove(sessionId: string): void;
  exit(): void;
}

const STATE_ORDER: Record<ManagedSessionState, number> = {
  needs_input: 0,
  working: 1,
  starting: 2,
  failed: 3,
  completed: 4,
  stopped: 5,
};

function stableOrderTime(record: ManagedSessionRecord): number {
  if (record.state === "completed" || record.state === "failed") {
    return record.completedAt ?? record.createdAt;
  }
  if (record.state === "stopped") return record.updatedAt;
  // Streaming events update `updatedAt` on every token. Active rows must use
  // their immutable creation time or concurrent workers continuously swap.
  return record.createdAt;
}

function compareRecords(a: ManagedSessionRecord, b: ManagedSessionRecord): number {
  return (
    STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
    stableOrderTime(b) - stableOrderTime(a) ||
    a.sessionId.localeCompare(b.sessionId)
  );
}

const MENTION_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next"]);

function mentionCandidates(root: string, query: string): { label: string }[] {
  const out: { label: string }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || out.length >= 50) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || MENTION_SKIP.has(name)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
        else {
          const path = relative(root, full);
          if (!query || path.includes(query)) out.push({ label: path });
        }
      } catch {}
      if (out.length >= 50) return;
    }
  };
  walk(root, 0);
  return out;
}

function age(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function stateLabel(state: ManagedSessionState, depth: ColorDepth): string {
  const style =
    state === "failed"
      ? { red: true }
      : state === "needs_input"
        ? { toolMutate: true, bold: true }
        : state === "completed"
          ? { permissive: true }
          : state === "stopped"
            ? { dim: true }
            : { accent: true };
  return styleText(state.replace("_", " "), style, depth);
}

export class AgentsApp {
  readonly editor = new Editor();
  private records: ManagedSessionRecord[] = [];
  private selected = 0;
  private peek = false;
  private help = false;
  private replyTarget: string | undefined;
  private removeTarget: string | undefined;
  private notice: string | undefined;
  private ctrlCArmedAt = 0;
  private dispatchModel: string | undefined;
  private modelItems: SelectItem[] = [];
  private readonly modelList = new SelectList([]);
  private modelQuery = "";
  private selectingModel = false;

  constructor(
    private width: number,
    private height: number,
    private depth: ColorDepth,
    private callbacks: AgentsAppCallbacks,
    private readonly now: () => number = Date.now,
  ) {}

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setRecords(records: readonly ManagedSessionRecord[]): void {
    const selectedId = this.selectedRecord?.sessionId;
    this.records = [...records].sort(compareRecords);
    if (selectedId) {
      const next = this.records.findIndex((record) => record.sessionId === selectedId);
      if (next !== -1) this.selected = next;
    }
    this.selected = Math.max(0, Math.min(this.selected, this.records.length - 1));
  }

  setNotice(message: string): void {
    this.notice = message;
  }

  setDispatchModels(items: readonly SelectItem[], selected: string): void {
    this.dispatchModel = selected;
    this.modelItems = [...items];
    if (!this.modelItems.some((item) => (item.value ?? item.label) === selected)) {
      this.modelItems.unshift({ label: selected, description: "current selection" });
    }
    this.refreshModelList();
  }

  get selectedRecord(): ManagedSessionRecord | undefined {
    return this.records[this.selected];
  }

  private get ctrlCPending(): boolean {
    return this.ctrlCArmedAt !== 0 && this.now() - this.ctrlCArmedAt < CTRL_C_EXIT_WINDOW_MS;
  }

  private handleCtrlC(): void {
    if (!this.editor.isEmpty) {
      this.editor.setText("");
      this.ctrlCArmedAt = 0;
      return;
    }
    if (this.ctrlCPending) {
      this.callbacks.exit();
      return;
    }
    this.ctrlCArmedAt = this.now();
  }

  private refreshModelList(): void {
    const query = this.modelQuery.trim().toLowerCase();
    this.modelList.setItems(
      query
        ? this.modelItems.filter((item) =>
            `${item.label} ${item.description ?? ""}`.toLowerCase().includes(query),
          )
        : this.modelItems,
    );
  }

  private openModelPicker(): void {
    if (this.modelItems.length === 0) {
      this.notice = "no authenticated models available";
      return;
    }
    this.notice = undefined;
    this.modelQuery = "";
    this.selectingModel = true;
    this.refreshModelList();
  }

  private chooseModel(model: string): void {
    this.dispatchModel = model;
    this.selectingModel = false;
    this.modelQuery = "";
    this.notice = `new sessions will use ${model}`;
  }

  private handleModelPickerInput(event: InputEvent): boolean {
    if (!this.selectingModel) return false;
    if (event.type === "paste") {
      this.modelQuery += event.text.replace(/\s+/g, " ");
      this.refreshModelList();
      return true;
    }
    if (event.type !== "key") return true;
    const key = event.key;
    if (key.name === "escape" || key.name === "left") {
      this.selectingModel = false;
      this.modelQuery = "";
      return true;
    }
    if (key.name === "up" || key.name === "down") {
      this.modelList.move(key.name);
      return true;
    }
    if (key.name === "backspace") {
      this.modelQuery = [...this.modelQuery].slice(0, -1).join("");
      this.refreshModelList();
      return true;
    }
    if (key.name === "return") {
      const selected = this.modelList.selected;
      if (selected) this.chooseModel(selected.value ?? selected.label);
      return true;
    }
    if (!key.alt && !key.ctrl && key.text) {
      this.modelQuery += key.text;
      this.refreshModelList();
    }
    return true;
  }

  handleInput(event: InputEvent): void {
    const confirmingCtrlC = event.type === "key" && event.key.ctrl && event.key.name === "c";
    if (this.ctrlCArmedAt !== 0 && !confirmingCtrlC) this.ctrlCArmedAt = 0;
    if (confirmingCtrlC) {
      this.handleCtrlC();
      return;
    }
    if (this.handleModelPickerInput(event)) return;
    if (event.type === "paste") {
      this.editor.insert(event.text);
      return;
    }
    if (event.type !== "key") return;
    const key = event.key;
    if (key.name === "escape" || key.name === "left") {
      if (this.help || this.peek || this.replyTarget || this.removeTarget) {
        this.help = false;
        this.peek = false;
        this.replyTarget = undefined;
        this.removeTarget = undefined;
        return;
      }
      if (!this.editor.isEmpty) this.editor.setText("");
      return;
    }
    if (key.name === "return") {
      const text = this.editor.submit().trim();
      if (text === "/model") {
        this.openModelPicker();
        return;
      }
      if (text.startsWith("/model ")) {
        const requested = text.slice("/model ".length).trim();
        const match = this.modelItems.find((item) => (item.value ?? item.label) === requested);
        if (match) this.chooseModel(match.value ?? match.label);
        else this.notice = `model is not available: ${requested}`;
        return;
      }
      if (text) {
        if (this.replyTarget) {
          this.callbacks.reply(this.replyTarget, text);
          this.replyTarget = undefined;
        } else {
          this.callbacks.dispatch(text, this.dispatchModel);
        }
      } else if (this.selectedRecord) {
        this.callbacks.attach(this.selectedRecord.sessionId);
      }
      return;
    }
    if (key.name === "up" && this.editor.isEmpty) {
      this.selected = Math.max(0, this.selected - 1);
      return;
    }
    if (key.name === "down" && this.editor.isEmpty) {
      this.selected = Math.min(this.records.length - 1, this.selected + 1);
      return;
    }
    if (key.name === "right" && this.editor.isEmpty && this.selectedRecord) {
      this.callbacks.attach(this.selectedRecord.sessionId);
      return;
    }
    if (key.name === "space" && this.editor.isEmpty) {
      this.peek = !this.peek;
      return;
    }
    if (key.name === "?" && this.editor.isEmpty) {
      this.help = !this.help;
      return;
    }
    if (key.name === "f" && this.editor.isEmpty && this.selectedRecord) {
      this.replyTarget = this.selectedRecord.sessionId;
      this.peek = false;
      return;
    }
    if (key.name === "x" && this.editor.isEmpty && this.selectedRecord) {
      this.callbacks.stop(this.selectedRecord.sessionId);
      return;
    }
    if (key.name === "delete" && this.editor.isEmpty && this.selectedRecord) {
      if (this.removeTarget === this.selectedRecord.sessionId) {
        this.callbacks.remove(this.selectedRecord.sessionId);
        this.removeTarget = undefined;
      } else {
        this.removeTarget = this.selectedRecord.sessionId;
      }
      return;
    }
    if (
      this.peek &&
      this.selectedRecord?.pendingRequest &&
      (key.name === "y" || key.name === "n")
    ) {
      this.callbacks.permission(
        this.selectedRecord.sessionId,
        this.selectedRecord.pendingRequest.id,
        key.name === "y" ? "allow" : "deny",
      );
      return;
    }
    if (key.ctrl && key.name === "j") {
      this.editor.newline();
      return;
    }
    if (key.name === "backspace") this.editor.backspace();
    else if (["left", "right", "home", "end"].includes(key.name)) {
      this.editor.move(key.name as "left" | "right" | "home" | "end");
    } else if (key.name === "space") this.editor.insert(" ");
    else if (!key.alt && !key.ctrl && key.text) this.editor.insert(key.text);
  }

  render(): string[] {
    const width = this.width;
    const header = [
      "",
      `${MARGIN}${styleText("mu agents", { accent: true, bold: true }, this.depth)}${styleText(
        " · ordinary sessions, one runtime each",
        { dim: true },
        this.depth,
      )}`,
      ...(this.dispatchModel
        ? [
            `${MARGIN}${styleText(`new sessions · ${this.dispatchModel}`, { dim: true }, this.depth)}`,
          ]
        : []),
      "",
    ];
    const mutating = this.records.filter((record) =>
      ["starting", "working", "needs_input"].includes(record.state),
    );
    if (mutating.length > 1) {
      header.push(
        `${MARGIN}${styleText(
          `same workspace · ${mutating.length} live sessions can edit concurrently`,
          { toolMutate: true },
          this.depth,
        )}`,
        "",
      );
    }

    const tail: string[] = [];
    if (this.help) tail.push(...this.helpRows());
    else if (this.peek && this.selectedRecord) tail.push(...this.peekRows(this.selectedRecord));
    if (this.removeTarget) {
      tail.push(
        "",
        `${MARGIN}${styleText("remove row only", { toolMutate: true, bold: true }, this.depth)}${styleText(
          " · session history remains · press delete again",
          { dim: true },
          this.depth,
        )}`,
      );
    }
    if (this.notice) tail.push("", `${MARGIN}${styleText(this.notice, { dim: true }, this.depth)}`);
    tail.push("", composerRule(width, this.depth));
    if (this.replyTarget) {
      tail.push(
        `${MARGIN}${styleText("follow-up to selected session", { accent: true }, this.depth)}`,
      );
    }
    if (this.selectingModel) {
      tail.push(
        `${MARGIN}${styleText(
          `select model for new sessions${this.modelQuery ? ` · ${this.modelQuery}` : ""}`,
          { bold: true },
          this.depth,
        )}`,
        ...this.modelList.render(width, this.depth),
      );
    } else {
      tail.push(...this.editor.render(width, this.depth));
    }
    tail.push(composerRule(width, this.depth));
    const footer = this.selectingModel
      ? "↑/↓ select · enter choose · esc cancel"
      : this.ctrlCPending
        ? "press ctrl+c again to exit"
        : "enter dispatch/attach · /model choose model · space peek · f follow-up · x stop · del remove · ? help · ctrl+c twice exit";
    tail.push(
      ...wrapText(footer, Math.max(10, width - MARGIN.length)).map(
        (line) => `${MARGIN}${styleText(line, { dim: true }, this.depth)}`,
      ),
    );

    const lines = [...header];
    if (this.records.length === 0) {
      lines.push(
        `${MARGIN}${styleText("no managed sessions", { dim: true }, this.depth)}`,
        `${MARGIN}${styleText("type a task below and press enter", { dim: true }, this.depth)}`,
        "",
      );
    } else {
      const availableRows = Math.max(3, this.height - header.length - tail.length);
      let visibleCount = Math.max(1, Math.floor(availableRows / 3));
      if (this.records.length > visibleCount) {
        // Streaming dashboards reserve a line at each edge for hidden-session
        // counts, keeping the selected record and composer inside the viewport.
        visibleCount = Math.max(1, Math.floor((availableRows - 2) / 3));
      }
      const maxStart = Math.max(0, this.records.length - visibleCount);
      const start = Math.min(maxStart, Math.max(0, this.selected - Math.floor(visibleCount / 2)));
      const end = Math.min(this.records.length, start + visibleCount);
      if (start > 0) {
        lines.push(
          `${MARGIN}${styleText(`… ${start} session${start === 1 ? "" : "s"} above`, { dim: true }, this.depth)}`,
        );
      }
      for (let index = start; index < end; index++) {
        lines.push(
          ...this.renderRow(this.records[index] as ManagedSessionRecord, index === this.selected),
        );
      }
      if (end < this.records.length) {
        const hidden = this.records.length - end;
        lines.push(
          `${MARGIN}${styleText(`… ${hidden} session${hidden === 1 ? "" : "s"} below`, { dim: true }, this.depth)}`,
        );
      }
    }
    lines.push(...tail);
    return lines;
  }

  private renderRow(record: ManagedSessionRecord, selected: boolean): string[] {
    const marker = selected ? styleText("›", { accent: true, bold: true }, this.depth) : " ";
    const finished = record.state === "completed" || record.state === "failed";
    // Attaching, detaching, and restarting a worker are record updates, but they
    // must not make an already-finished run appear newly completed.
    const timestamp = finished ? (record.completedAt ?? record.updatedAt) : record.updatedAt;
    const suffix = styleText(
      ` · ${age(timestamp, this.now())}${finished ? " ago" : ""}`,
      { dim: true },
      this.depth,
    );
    const available = Math.max(10, this.width - 8);
    const name = truncateToWidth(record.name, Math.max(8, available - 24));
    const summary = truncateToWidth(record.summary, available);
    return [
      `${MARGIN}${marker} ${styleText(name, selected ? { bold: true } : {}, this.depth)} ${stateLabel(
        record.state,
        this.depth,
      )}${suffix}`,
      `${MARGIN}  ${styleText(summary, { dim: true }, this.depth)}`,
      "",
    ];
  }

  private peekRows(record: ManagedSessionRecord): string[] {
    const body = record.pendingRequest?.description ?? record.lastError ?? record.summary;
    return [
      composerRule(this.width, this.depth),
      `${MARGIN}${styleText(record.name, { bold: true }, this.depth)} ${stateLabel(record.state, this.depth)}`,
      ...wrapText(body, Math.max(10, this.width - MARGIN.length)).map((line) => `${MARGIN}${line}`),
      `${MARGIN}${styleText(record.sessionId, { dim: true }, this.depth)}`,
      ...(record.pendingRequest
        ? [`${MARGIN}${styleText("y allow · n deny", { toolMutate: true }, this.depth)}`]
        : []),
      composerRule(this.width, this.depth),
    ];
  }

  private helpRows(): string[] {
    return [
      composerRule(this.width, this.depth),
      `${MARGIN}${styleText("agent view keys", { accent: true, bold: true }, this.depth)}`,
      `${MARGIN}↑/↓ select · enter/right attach · space peek`,
      `${MARGIN}f follow-up · x stop runtime · delete remove row`,
      `${MARGIN}/model select the model for new sessions`,
      `${MARGIN}left/esc back · ctrl+c twice leaves sessions running`,
      composerRule(this.width, this.depth),
    ];
  }
}

interface ActiveConversation {
  sessionId: string;
  app: App;
  disposePresentation?: () => Promise<void>;
}

export async function rendererRegistryForManagedProfile(
  record: Pick<ManagedSessionRecord, "profile" | "workingCwd">,
  load: typeof resolveProfile = resolveProfile,
): Promise<{ registry: RendererRegistry; dispose: () => Promise<void> }> {
  const registry = new RendererRegistry();
  registerProductRenderers(registry, codingProduct.renderers);
  if (record.profile === DEFAULT_PROFILE) return { registry, dispose: async () => {} };

  const profile: Profile = await load(record.profile, {
    root: record.workingCwd,
    presentationOnly: true,
  });
  registerDeclaredRenderers(registry, Object.entries(profile.renderers ?? {}));
  return {
    registry,
    dispose: async () => {
      await profile.runtime?.shutdown?.();
    },
  };
}

export async function runAgentView(
  args: ParsedArgs<CodingProductOptions>,
  options: { initialSessionId?: string; exitAfterDetach?: boolean } = {},
): Promise<number> {
  const terminal = new Terminal();
  if (!terminal.isTty) {
    process.stderr.write("mu: not a terminal\n");
    return 2;
  }
  const cwd = process.cwd();
  const dispatchModel = await resolveCliModel(args.model, userConfigPath());
  const auth = await readAuthFile().catch(() => ({ version: 1 as const, providers: {} }));
  const selectableModels = modelPickerItems(new ExtensionHost(), auth.providers);
  const depth = detectColorDepth();
  const renderer = new FullScreenRenderer(terminal);
  const client = new AgentViewClient({ scope: scopeForCurrentProject(cwd), cwd });
  await client.connect();
  let exiting = false;
  let active: ActiveConversation | undefined;
  let attaching = false;
  let app: AgentsApp;
  const paint = () => renderer.requestRender(() => active?.app.renderScreen() ?? app.render());

  const showError = (error: unknown) => {
    app.setNotice(error instanceof Error ? error.message : String(error));
    paint();
  };

  const detach = async () => {
    if (!active) return;
    const detached = active;
    const sessionId = detached.sessionId;
    active = undefined;
    await client.detach(sessionId).catch(showError);
    await detached.disposePresentation?.().catch(showError);
    if (options.exitAfterDetach) {
      exiting = true;
      return;
    }
    terminal.setTitle(`mu agents - ${basename(cwd) || cwd}`);
    renderer.clear();
    app.setRecords(client.records);
    paint();
  };

  const openAttachment = async (sessionId: string) => {
    if (attaching || active) return;
    attaching = true;
    let attached = false;
    let disposePresentation: (() => Promise<void>) | undefined;
    try {
      const snapshot = await client.attach(sessionId);
      attached = true;
      const record = client.records.find((candidate) => candidate.sessionId === sessionId);
      if (!record) throw new Error(`managed session ${sessionId} is no longer available`);
      const presentation = await rendererRegistryForManagedProfile(record);
      const { registry } = presentation;
      disposePresentation = presentation.dispose;
      let conversation: App;
      conversation = new App({
        width: terminal.columns,
        height: terminal.rows,
        depth,
        model: snapshot.model,
        version: cliPackage.version,
        cwd: formatCwdForFooter(cwd, process.env.HOME ?? process.env.USERPROFILE),
        contextWindow: snapshot.contextWindow,
        thinkingLevels: snapshot.thinkingLevels,
        registry,
        callbacks: {
          onSubmit: (text) =>
            void client.sessionOp(sessionId, { type: "input", text }).catch(showError),
          onSteer: (text) => {
            void client.sessionOp(sessionId, { type: "steer", text }).catch(showError);
            return true;
          },
          onFollowUp: (text) => {
            void client.sessionOp(sessionId, { type: "follow_up", text }).catch(showError);
            return true;
          },
          onEditQueued: (kind, text) => {
            void client
              .sessionOp(sessionId, { type: "remove_queued", kind, text })
              .catch(showError);
            return true;
          },
          onShell: (command) =>
            void client.sessionOp(sessionId, { type: "shell", command }).catch(showError),
          onMentionQuery: (query) => mentionCandidates(cwd, query),
          onAbort: () => void client.sessionOp(sessionId, { type: "abort" }).catch(showError),
          onExit: () => void detach(),
          onDetach: () => void detach(),
          onCommand: (text) => {
            if (text.trim() === "/model" && snapshot.models?.length) {
              conversation.openPicker({
                title: `select a model · ${snapshot.models.length} available`,
                filterable: true,
                items: snapshot.models,
                onChoose: (model) =>
                  void client
                    .sessionOp(sessionId, { type: "command", text: `/model ${model}` })
                    .catch(showError),
                onBack: () => conversation.openCommandMenu(),
              });
              return;
            }
            if (text.trim() === "/permissions" && snapshot.permissionModes?.length) {
              conversation.openPicker({
                title: "update permissions",
                items: snapshot.permissionModes.map((mode) => ({
                  label: mode.label,
                  description: `${mode.description}${mode.id === snapshot.permissionMode ? " · current" : ""}`,
                  value: mode.id,
                })),
                onChoose: (id) =>
                  void client
                    .sessionOp(sessionId, { type: "permission_mode", id })
                    .catch(showError),
                onBack: () => conversation.openCommandMenu(),
              });
              return;
            }
            void client.sessionOp(sessionId, { type: "command", text }).catch(showError);
          },
          onThinkingChange: (level) =>
            void client.sessionOp(sessionId, { type: "thinking", level }).catch(showError),
          onCyclePermissionMode: () =>
            void client.sessionOp(sessionId, { type: "cycle_permission_mode" }).catch(showError),
          onPermissionReply: (requestId, outcome, remember) =>
            void client
              .sessionOp(sessionId, { type: "permission_reply", requestId, outcome, remember })
              .catch(showError),
        },
      });
      conversation.setThinking(snapshot.thinking, snapshot.thinkingLevels);
      conversation.setCommands([
        ...(snapshot.commands ?? []),
        ...(snapshot.permissionModes?.length
          ? [{ label: "permissions", description: "Choose what mu is allowed to do" }]
          : []),
      ]);
      conversation.replaceTranscript(snapshot.messages, conversation.banner());
      for (const event of snapshot.events ?? []) conversation.handleEvent(event);
      if (snapshot.isRunning) conversation.handleEvent({ type: "agent_start" });
      if (snapshot.pendingRequest) {
        conversation.handleEvent({ type: "permission_asked", request: snapshot.pendingRequest });
      }
      conversation.handleEvent({
        type: "usage_updated",
        sessionTotals: snapshot.usage,
        contextTokens: Math.round(snapshot.contextPercent * snapshot.contextWindow),
        contextPercent: snapshot.contextPercent,
      });
      active = { sessionId, app: conversation, disposePresentation };
      disposePresentation = undefined;
      terminal.setTitle(`mu - ${basename(cwd) || cwd}`);
      renderer.clear();
      await client.resize(sessionId, terminal.columns, terminal.rows);
      paint();
    } catch (error) {
      await disposePresentation?.().catch(() => {});
      if (attached) await client.detach(sessionId).catch(() => {});
      showError(error);
    } finally {
      attaching = false;
    }
  };

  app = new AgentsApp(terminal.columns, terminal.rows, depth, {
    dispatch: (prompt, model) =>
      void client
        .dispatch({
          prompt,
          cwd,
          profile: args.profile ?? DEFAULT_PROFILE,
          model: model ?? dispatchModel,
          ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
          ...(args.noInstructions ? { noInstructions: true } : {}),
          environment: dispatchEnvironment(),
        })
        .catch(showError),
    attach: (sessionId) => void openAttachment(sessionId),
    reply: (sessionId, text) =>
      void client.sessionOp(sessionId, { type: "input", text }).catch(showError),
    permission: (sessionId, requestId, outcome) =>
      void client
        .sessionOp(sessionId, { type: "permission_reply", requestId, outcome })
        .catch(showError),
    stop: (sessionId) => void client.stop(sessionId).catch(showError),
    remove: (sessionId) => void client.remove(sessionId).catch(showError),
    exit: () => {
      exiting = true;
    },
  });
  app.setDispatchModels(selectableModels, dispatchModel);
  app.setRecords(client.records);
  const unsubscribe = client.subscribe((response: AgentViewResponse) => {
    app.setRecords(client.records);
    if (active && response.type === "event" && response.sessionId === active.sessionId) {
      active.app.handleEvent(response.event);
    } else if (
      active &&
      response.type === "command_result" &&
      response.sessionId === active.sessionId
    ) {
      if (response.runtime) {
        active.app.setModel(response.runtime.model, response.runtime.contextWindow);
        active.app.setThinking(response.runtime.thinking, response.runtime.thinkingLevels);
      }
      const data = response.data as
        | CheckpointActionData
        | DiffCommandData
        | { kind: "fork-points"; points: { id: string; description: string }[] }
        | { kind: "compaction"; status: string }
        | undefined;
      if (data?.kind === "checkpoint") {
        if (data.action === "undo" && data.prompt !== undefined) {
          active.app.editor.setText(data.prompt);
        } else if (data.action === "redo") {
          active.app.editor.setText("");
        }
        active.app.appendTranscript(renderCheckpointCommand(data, terminal.columns, depth));
      } else if (data?.kind === "diff") {
        active.app.appendTranscript(renderDiffCommand(data, terminal.columns, depth));
      } else if (data?.kind === "fork-points") {
        const sessionId = active.sessionId;
        active.app.openPicker({
          title: "fork from",
          items: data.points.map((point) => ({
            label: point.id,
            description: point.description,
          })),
          onChoose: (entryId) =>
            void client.sessionOp(sessionId, { type: "command", text: `/fork ${entryId}` }),
          onBack: () => active?.app.openCommandMenu(),
        });
      } else if (data?.kind !== "compaction" || data.status === "queued") {
        if (response.message) {
          active.app.appendTranscript(
            response.message.split("\n").map((line) => `${MARGIN}${line}`),
          );
        }
      }
    }
    paint();
  });

  terminal.onExit = () => {
    exiting = true;
    client.close();
  };
  terminal.start();
  terminal.setTitle(`mu agents - ${basename(cwd) || cwd}`);
  if (options.initialSessionId) await openAttachment(options.initialSessionId);
  const stopResize = terminal.onResize(() => {
    app.setSize(terminal.columns, terminal.rows);
    if (active) {
      active.app.setSize(terminal.columns, terminal.rows);
      void client.resize(active.sessionId, terminal.columns, terminal.rows).catch(showError);
    }
    paint();
  });
  const decoder = new InputDecoder();
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  paint();
  try {
    for await (const chunk of process.stdin) {
      for (const event of decoder.push(String(chunk))) {
        if (active) active.app.handleInput(event);
        else app.handleInput(event);
      }
      if (decoder.pending.length > 0) {
        if (escapeTimer) clearTimeout(escapeTimer);
        escapeTimer = setTimeout(() => {
          const event = decoder.flushPendingEscape();
          if (event) {
            if (active) active.app.handleInput(event);
            else app.handleInput(event);
            paint();
          }
        }, 30);
      }
      paint();
      if (exiting) break;
    }
  } finally {
    if (escapeTimer) clearTimeout(escapeTimer);
    if (active) {
      await client.detach(active.sessionId).catch(() => {});
      await active.disposePresentation?.().catch(() => {});
    }
    unsubscribe();
    stopResize();
    client.close();
    renderer.stop();
    terminal.restore();
  }
  return 0;
}
