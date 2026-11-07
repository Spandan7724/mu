import { describe, expect, test } from "bun:test";
import type { SkillEntry } from "mu";
import {
  nextSkillState,
  skillPickerItems,
  skillPickerSummary,
  skillPickerTitle,
} from "./skills-picker.ts";

const entry = (name: string, state: SkillEntry["state"]): SkillEntry => ({
  name,
  description: `${name} skill`,
  directory: `/home/u/.agents/skills/${name}`,
  scope: "user",
  source: "agents",
  state,
  defaultState: "on",
});

describe("skills picker", () => {
  test("space cycles on, manual, off", () => {
    expect([nextSkillState("on"), nextSkillState("manual"), nextSkillState("off")]).toEqual([
      "manual",
      "off",
      "on",
    ]);
  });

  test("rows carry the state mark, a manual tag, a muted off row and the description", () => {
    const [on, manual, off] = skillPickerItems([
      entry("pdf", "on"),
      entry("docx", "manual"),
      entry("xlsx", "off"),
    ]);
    expect(on).toMatchObject({ label: "pdf", description: "user .agents", detail: "pdf skill" });
    expect(on?.mark?.glyph).toBe("●");
    expect(manual?.mark?.glyph).toBe("◐");
    expect(manual?.tag?.text).toBe("manual");
    expect(off).toMatchObject({ muted: true, mark: { glyph: "○" } });
  });

  test("the title counts states and the summary names only what changed", () => {
    const skills = [entry("pdf", "on"), entry("docx", "manual"), entry("xlsx", "off")];
    expect(skillPickerTitle(skills)).toBe(
      "turn skills on or off · space cycle · 1 on · 1 manual · 1 off",
    );
    const before = new Map(skills.map((skill) => [skill.name, skill.state]));
    expect(skillPickerSummary(before, skills, "~/.mu/config.json")).toBeUndefined();
    before.set("docx", "on");
    before.set("xlsx", "on");
    expect(skillPickerSummary(before, skills, "~/.mu/config.json")).toBe(
      "Set to manual: docx; Turned off xlsx · saved to ~/.mu/config.json",
    );
  });
});
