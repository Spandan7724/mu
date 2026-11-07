import type { SelectItem } from "@mu/tui";
import type { SkillEntry, SkillState } from "mu";

const SOURCE_LABEL: Record<SkillEntry["source"], string> = {
  mu: ".mu",
  agents: ".agents",
  claude: ".claude",
  codex: ".codex",
  opencode: "opencode",
};

export function nextSkillState(state: SkillState): SkillState {
  return state === "on" ? "manual" : state === "manual" ? "off" : "on";
}

export function skillPickerItems(skills: SkillEntry[]): SelectItem[] {
  return skills.map((skill) => ({
    label: skill.name,
    value: skill.name,
    description: `${skill.scope} ${SOURCE_LABEL[skill.source]}`,
    detail: skill.description,
    mark:
      skill.state === "on"
        ? { glyph: "●", style: { accent: true } }
        : skill.state === "manual"
          ? { glyph: "◐", style: { toolMutate: true } }
          : { glyph: "○", style: { dim: true } },
    ...(skill.state === "manual" ? { tag: { text: "manual", style: { toolMutate: true } } } : {}),
    ...(skill.state === "off" ? { muted: true } : {}),
  }));
}

export function skillPickerTitle(skills: SkillEntry[]): string {
  const count = (state: SkillState) => skills.filter((skill) => skill.state === state).length;
  const parts = [`${count("on")} on`];
  if (count("manual") > 0) parts.push(`${count("manual")} manual`);
  if (count("off") > 0) parts.push(`${count("off")} off`);
  return ["turn skills on or off", "space cycle", ...parts].join(" · ");
}

// What changed since the picker opened, for the line printed when it closes.
export function skillPickerSummary(
  before: Map<string, SkillState>,
  skills: SkillEntry[],
  file: string,
): string | undefined {
  const changed = skills.filter((skill) => before.get(skill.name) !== skill.state);
  if (changed.length === 0) return undefined;
  const named = (state: SkillState) =>
    changed
      .filter((skill) => skill.state === state)
      .map((skill) => skill.name)
      .join(", ");
  const parts = [
    named("on") && `Turned on ${named("on")}`,
    named("manual") && `Set to manual: ${named("manual")}`,
    named("off") && `Turned off ${named("off")}`,
  ].filter(Boolean);
  return `${parts.join("; ")} · saved to ${file}`;
}
