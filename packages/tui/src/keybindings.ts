// Canonical keybinding reference for /keybindings — kept beside app.ts's
// actual key-handling so the two are easy to keep in sync by inspection.

export interface Keybinding {
  keys: string;
  description: string;
}

export interface KeybindingGroup {
  title: string;
  bindings: Keybinding[];
}

export const KEYBINDING_GROUPS: KeybindingGroup[] = [
  {
    title: "Global",
    bindings: [
      { keys: "ctrl+c", description: "exit mu" },
      {
        keys: "ctrl+o",
        description: "open activity navigation and toggle the selected group or tool",
      },
      {
        keys: "ctrl+t",
        description: "cycle the model's thinking effort, if it supports more than one level",
      },
      {
        keys: "shift+tab",
        description: "cycle permission modes",
      },
      { keys: "ctrl+b", description: "switch between the main and side conversations" },
      { keys: "ctrl+j", description: "insert a newline in the composer" },
    ],
  },
  {
    title: "Composer",
    bindings: [
      {
        keys: "enter",
        description: "submit — steers a running turn, or queues a follow-up during compaction",
      },
      {
        keys: "shift+enter · ctrl+enter · alt+enter",
        description: "insert a newline, on terminals that report the modifier",
      },
      { keys: "\\ then enter", description: "insert a newline — works on every terminal" },
      {
        keys: "tab",
        description:
          "complete the highlighted command or file; queues a follow-up while the agent is running",
      },
      { keys: "alt+up", description: "edit the most recently queued steer/follow-up message" },
      {
        keys: "escape",
        description:
          "abort a running turn, clear a started !shell line, or close an idle side conversation",
      },
      { keys: "/ at the start of an empty line", description: "open the command menu" },
      { keys: "@", description: "open the file-mention popup" },
      {
        keys: "! at the start of an empty line",
        description: "enter shell mode — a direct local command, no model call",
      },
    ],
  },
];

export function formatKeybindings(): string {
  const groups = KEYBINDING_GROUPS.map((group) => {
    const keyWidth = Math.max(...group.bindings.map((binding) => binding.keys.length));
    const rows = group.bindings.map(
      (binding) => `    ${binding.keys.padEnd(keyWidth)}  ${binding.description}`,
    );
    return [`  ${group.title}`, ...rows].join("\n");
  });
  return ["Keybindings", ...groups].join("\n\n");
}
