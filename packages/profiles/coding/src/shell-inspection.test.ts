import { describe, expect, test } from "bun:test";
import {
  classifyShellCommand,
  isInspectionShellCommand,
  isSingleRipgrepCommand,
  parseInspectionCommands,
} from "./shell-inspection.ts";

describe("shell inspection classification", () => {
  test("accepts targeted repository inspection commands", () => {
    for (const command of [
      "rg --files src tests",
      'rg -n "class Agent|function run" packages',
      "sed -n '200,360p' packages/core/src/loop.ts",
      "head -80 README.md",
      "tail -40 README.md",
      "find packages -maxdepth 3 -type f",
      "git status --short",
      "git diff --stat",
      "git log --oneline -5",
      "git branch --show-current",
    ]) {
      expect(classifyShellCommand(command)).toBe("inspect");
    }
  });

  test("accepts safe pipelines and command batches only when every stage is safe", () => {
    const command = [
      "rg --files packages tests | head -200",
      'rg -n "permission|bash" packages/core packages/sdk',
      "sed -n '1,220p' packages/core/src/permission.ts",
      "git status --short",
    ].join(" && ");

    expect(parseInspectionCommands(command)).toHaveLength(5);
    expect(isInspectionShellCommand(command)).toBe(true);
    expect(isInspectionShellCommand("rg todo src | xargs rm")).toBe(false);
    expect(isInspectionShellCommand("rg todo src && npm test")).toBe(false);
  });

  test("accepts shell-simple ripgrep discovery and multi-pattern searches", () => {
    const command = [
      "rg --files --sort path packages/profiles/coding/src -g '*.ts'",
      "rg -n --no-messages -e 'name: \"grep\"' -e 'name: \"glob\"' packages/profiles/coding/src",
    ].join("; ");

    expect(isInspectionShellCommand(command)).toBe(true);
  });

  test("identifies only one safe ripgrep invocation for no-match semantics", () => {
    expect(isSingleRipgrepCommand("rg -n -e 'grepTool' packages")).toBe(true);
    expect(isSingleRipgrepCommand("rg --files --sort path packages")).toBe(true);
    expect(isSingleRipgrepCommand("rg missing packages | head -20")).toBe(false);
    expect(isSingleRipgrepCommand("rg missing packages; false")).toBe(false);
    expect(isSingleRipgrepCommand("rg --pre cat missing packages")).toBe(false);
    expect(isSingleRipgrepCommand("./rg missing packages")).toBe(false);
    expect(isSingleRipgrepCommand("grep missing packages")).toBe(false);
  });

  test("treats newlines as command boundaries", () => {
    expect(isInspectionShellCommand("rg --files\ngit status --short\n")).toBe(true);
    expect(isInspectionShellCommand("rg --files\nrm generated.txt")).toBe(false);
  });

  test("rejects dynamic or mutating shell syntax from the inspection scope", () => {
    for (const command of [
      "rg todo > matches.txt",
      "rg todo >> matches.txt",
      "cat < input.txt",
      "rg $(cat pattern.txt) src",
      "rg `cat pattern.txt` src",
      "(rg todo src)",
      "rg todo src &",
      "rg todo src | tee matches.txt",
      "echo $" + "{VALUE}",
      "# inspect\nrg --files",
    ]) {
      expect(classifyShellCommand(command)).toBe("other");
    }
  });

  test("rejects unsafe options on otherwise read-only-looking commands", () => {
    for (const command of [
      "find . -delete",
      "find . -exec rm {} ;",
      "find . -fprintf output.txt %p",
      "rg --pre cat pattern .",
      "rg --search-zip pattern .",
      "base64 --output=data.txt input.txt",
      "sed -i s/old/new/ file.txt",
      "sed -n '1p;w output.txt' file.txt",
      "git diff --output=changes.patch",
      "git diff --ext-diff",
      "git -C ../other status",
    ]) {
      expect(classifyShellCommand(command)).toBe("other");
    }
  });

  test("only accepts read-only git operations", () => {
    for (const command of [
      "git add .",
      "git commit -m test",
      "git checkout main",
      "git branch feature",
      "git branch -D old",
      "git reset --hard",
      "git clean -fd",
      "git push",
    ]) {
      expect(classifyShellCommand(command)).toBe("other");
    }
  });

  test("fails closed for malformed and unknown commands", () => {
    for (const command of [
      "",
      "   ",
      "rg 'unterminated",
      "rg todo &&",
      "python inspect.py",
      "./rg --files",
      "/tmp/git status",
    ]) {
      expect(classifyShellCommand(command)).toBe("other");
    }
  });
});
