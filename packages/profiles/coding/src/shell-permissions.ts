import type { PermissionTarget } from "@mu/core";
import { classifyShellCommand } from "./shell-inspection.ts";

// Words after the command name that a saved "always allow" keeps, so
// `bun run test --watch` saves `bun run test *`. Unlisted commands keep only
// their name.
const PREFIX_WORDS: Record<string, number> = {
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  bunx: 2,
  cargo: 2,
  "cargo run": 3,
  cmake: 2,
  composer: 2,
  deno: 2,
  "deno task": 3,
  docker: 2,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  kubectl: 2,
  make: 2,
  mvn: 2,
  npm: 2,
  "npm exec": 3,
  "npm run": 3,
  npx: 2,
  pip: 2,
  pip3: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  rustup: 2,
  swift: 2,
  terraform: 2,
  turbo: 2,
  uv: 2,
  "uv run": 3,
  yarn: 2,
  "yarn run": 3,
};

// A prefix rule for these would allow arbitrary code or arbitrary deletion,
// so "always allow" saves the exact command instead.
const EXACT_ONLY = new Set([
  ".",
  "bash",
  "builtin",
  "chgrp",
  "chmod",
  "chown",
  "cmd",
  "command",
  "csh",
  "curl",
  "dash",
  "dd",
  "doas",
  "env",
  "eval",
  "exec",
  "fish",
  "ionice",
  "kill",
  "killall",
  "ksh",
  "lua",
  "mkfs",
  "nice",
  "node",
  "nohup",
  "osascript",
  "perl",
  "php",
  "pkill",
  "powershell",
  "pwsh",
  "python",
  "python2",
  "python3",
  "rm",
  "rmdir",
  "rsync",
  "ruby",
  "scp",
  "sh",
  "shred",
  "source",
  "ssh",
  "su",
  "sudo",
  "tcsh",
  "time",
  "timeout",
  "watch",
  "wget",
  "xargs",
  "zsh",
]);

const CONTROL_WORDS = new Set([
  "!",
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "select",
  "then",
  "until",
  "while",
  "{",
  "}",
]);

const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Word {
  raw: string;
  value: string;
  dynamic: boolean; // holds a $ expansion
}

interface Segment {
  words: Word[];
  // Output redirections other than to /dev/null or another descriptor.
  writes: string[];
  start: number;
  end: number;
}

function executableName(raw: string): string {
  const name = raw.split(/[\\/]/).at(-1)?.toLowerCase() ?? raw.toLowerCase();
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

// Splits a POSIX shell line into the simple commands it runs. Anything that
// can run code the words do not show (substitution, subshells, groups,
// heredocs, control flow, comments) returns undefined.
function splitCommands(source: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let writes: string[] = [];
  let start = 0;
  let raw = "";
  let value = "";
  let dynamic = false;
  let started = false;
  let quote: "single" | "double" | undefined;
  let pendingRedirect: { output: boolean; operator: string } | undefined;

  const finishWord = (): boolean => {
    if (!started) return true;
    const word = { raw, value, dynamic };
    raw = "";
    value = "";
    dynamic = false;
    started = false;
    if (pendingRedirect) {
      const redirect = pendingRedirect;
      pendingRedirect = undefined;
      if (redirect.output && word.value !== "/dev/null") {
        writes.push(`${redirect.operator}${word.raw}`);
      }
      return true;
    }
    words.push(word);
    return true;
  };
  const finishCommand = (end: number, allowEmpty: boolean): boolean => {
    finishWord();
    if (pendingRedirect) return false;
    if (words.length === 0) {
      if (!allowEmpty || writes.length > 0) return false;
    } else {
      segments.push({ words, writes, start, end });
    }
    words = [];
    writes = [];
    return true;
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? "";

    if (quote === "single") {
      raw += character;
      if (character === "'") quote = undefined;
      else value += character;
      continue;
    }
    if (quote === "double") {
      raw += character;
      if (character === '"') {
        quote = undefined;
      } else if (character === "`") {
        return undefined;
      } else if (character === "$") {
        const next = source[index + 1];
        if (next === "(" || next === "{") return undefined;
        dynamic = true;
        value += character;
      } else if (character === "\\") {
        const next = source[++index];
        if (next === undefined) return undefined;
        raw += next;
        if (next !== "\n") value += next;
      } else {
        value += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      started = true;
      raw += character;
      continue;
    }
    if (character === "\\") {
      const next = source[++index];
      if (next === undefined) return undefined;
      if (next !== "\n") {
        started = true;
        raw += `\\${next}`;
        value += next;
      }
      continue;
    }
    if (character === "`" || character === "(" || character === ")") return undefined;
    if (character === "$") {
      const next = source[index + 1];
      if (next === "(" || next === "{") return undefined;
      started = true;
      dynamic = true;
      raw += character;
      value += character;
      continue;
    }
    if (character === "#" && !started) return undefined;

    if (character === ">" || character === "<") {
      // A word of digits right before the operator is a file descriptor.
      let operator = character;
      if (started && /^\d+$/.test(raw)) {
        operator = `${raw}${character}`;
        raw = "";
        value = "";
        started = false;
      } else if (!finishWord()) {
        return undefined;
      }
      if (pendingRedirect) return undefined;
      const next = source[index + 1];
      if (character === "<" && next === "<") return undefined;
      if (
        next === ">" ||
        (character === ">" && next === "|") ||
        (character === "<" && next === ">")
      ) {
        operator += next;
        index++;
      }
      if (source[index + 1] === "&") {
        // Duplicating a descriptor (2>&1, >&2) writes no file.
        const target = /^&(\d+|-)/.exec(source.slice(index + 1));
        if (!target) return undefined;
        index += target[0].length;
        continue;
      }
      pendingRedirect = { output: character === ">" || operator.endsWith(">"), operator };
      continue;
    }

    if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index++;
      if (!finishCommand(index, true)) return undefined;
      start = index + 1;
      continue;
    }
    if (character === " " || character === "\t") {
      finishWord();
      continue;
    }
    if (character === ";") {
      if (source[index + 1] === ";") return undefined;
      if (!finishCommand(index, false)) return undefined;
      start = index + 1;
      continue;
    }
    if (character === "&") {
      if (source[index + 1] === ">") {
        // &> and &>> redirect both streams.
        if (!finishWord() || pendingRedirect) return undefined;
        let operator = "&>";
        index++;
        if (source[index + 1] === ">") {
          operator += ">";
          index++;
        }
        pendingRedirect = { output: true, operator };
        continue;
      }
      const double = source[index + 1] === "&";
      if (!finishCommand(index, false)) return undefined;
      if (double) index++;
      start = index + 1;
      continue;
    }
    if (character === "|") {
      const next = source[index + 1];
      if (!finishCommand(index, false)) return undefined;
      if (next === "|" || next === "&") index++;
      start = index + 1;
      continue;
    }

    started = true;
    raw += character;
    value += character;
  }

  if (quote) return undefined;
  if (!finishCommand(source.length, true)) return undefined;
  if (segments.length === 0) return undefined;
  // Control flow and groups decide what runs from words in other segments.
  if (
    segments.some((segment) =>
      CONTROL_WORDS.has(segment.words[commandIndex(segment.words)]?.value ?? ""),
    )
  ) {
    return undefined;
  }
  return segments;
}

function commandIndex(words: Word[]): number {
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index]?.value ?? "")) index++;
  return index;
}

function segmentPattern(segment: Segment): string {
  const at = commandIndex(segment.words);
  return [
    ...segment.words.map((word, index) =>
      // The command name is matched as it runs, so quoting it cannot dodge a rule.
      index === at && PLAIN_WORD.test(word.value) ? word.value : word.raw,
    ),
    ...segment.writes,
  ].join(" ");
}

function rememberPattern(words: Word[], pattern: string): string {
  const at = commandIndex(words);
  const name = words[at];
  if (!name || name.dynamic || !PLAIN_WORD.test(name.value)) return pattern;
  if (EXACT_ONLY.has(executableName(name.value))) return pattern;
  const values = words.slice(at).map((word) => word.value);
  let length = 1;
  for (let size = Math.min(values.length, 2); size > 0; size--) {
    const known = PREFIX_WORDS[values.slice(0, size).join(" ")];
    if (known !== undefined) {
      length = known;
      break;
    }
  }
  const prefix = words.slice(at, at + length);
  if (prefix.length < length || prefix.some((word) => word.dynamic || !PLAIN_WORD.test(word.value)))
    return pattern;
  const assignments = words.slice(0, at);
  if (assignments.some((word) => word.dynamic)) return pattern;
  return [...assignments.map((word) => word.raw), ...prefix.map((word) => word.value), "*"].join(
    " ",
  );
}

function scope(command: string, background: boolean): string {
  return !background && classifyShellCommand(command) === "inspect" ? "bash:inspect" : "bash";
}

// One target per command a shell line runs, so a rule allowing `npm test *`
// does not also allow `npm test && curl … | sh`. Lines that cannot be split
// with certainty are judged whole, and only an identical rule (or `*`) matches.
export function shellPermissionTargets(
  command: string,
  options: { background?: boolean; platform?: NodeJS.Platform } = {},
): PermissionTarget[] {
  const background = options.background === true;
  const whole = command.trim();
  const permission = scope(command, background);
  if ((options.platform ?? process.platform) === "win32") {
    // PowerShell is not split; a line with any operator is judged as written.
    if (/[;|&`$<>(){}#\r\n]/.test(whole)) return [{ permission, pattern: whole, exact: true }];
    const words = whole
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({ raw: word, value: word, dynamic: false }));
    return [{ permission, pattern: whole, remember: rememberPattern(words, whole) }];
  }
  const segments = splitCommands(command);
  if (!segments) return [{ permission, pattern: whole, exact: true }];

  return segments.map((segment) => {
    const pattern = segmentPattern(segment);
    const name = segment.words[commandIndex(segment.words)];
    const permission = scope(command.slice(segment.start, segment.end), background);
    if (!name || name.dynamic || segment.writes.length > 0) {
      return { permission, pattern, exact: true };
    }
    return { permission, pattern, remember: rememberPattern(segment.words, pattern) };
  });
}
