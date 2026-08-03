export type ShellCommandClassification = "inspect" | "other";

const SIMPLE_INSPECTION_COMMANDS = new Set([
  "base64",
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

const UNSAFE_FIND_OPTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);

const UNSAFE_RG_OPTIONS = ["--hostname-bin", "--pre"];
const UNSAFE_GIT_GLOBAL_OPTIONS = [
  "-C",
  "-c",
  "-p",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--paginate",
  "--super-prefix",
  "--work-tree",
];
const UNSAFE_GIT_SUBCOMMAND_OPTIONS = ["--exec", "--ext-diff", "--output", "--textconv"];

function executableName(raw: string): string {
  const name = raw.split(/[\\/]/).at(-1)?.toLowerCase() ?? raw.toLowerCase();
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function optionMatches(argument: string, option: string): boolean {
  if (argument === option || argument.startsWith(`${option}=`)) return true;
  return option.length === 2 && argument.startsWith(option) && argument.length > option.length;
}

function containsOption(arguments_: string[], options: string[]): boolean {
  return arguments_.some((argument) => options.some((option) => optionMatches(argument, option)));
}

function isReadOnlyGitCommand(command: string[]): boolean {
  const globalArguments: string[] = [];
  let subcommandIndex = -1;
  let skipValue = false;

  for (let index = 1; index < command.length; index++) {
    const argument = command[index] ?? "";
    if (skipValue) {
      globalArguments.push(argument);
      skipValue = false;
      continue;
    }
    if (argument === "--") return false;
    if (argument.startsWith("-")) {
      globalArguments.push(argument);
      if (
        [
          "-C",
          "-c",
          "--config-env",
          "--exec-path",
          "--git-dir",
          "--namespace",
          "--super-prefix",
          "--work-tree",
        ].includes(argument)
      ) {
        skipValue = true;
      }
      continue;
    }
    subcommandIndex = index;
    break;
  }

  if (subcommandIndex === -1 || containsOption(globalArguments, UNSAFE_GIT_GLOBAL_OPTIONS)) {
    return false;
  }

  const subcommand = command[subcommandIndex]?.toLowerCase();
  const arguments_ = command.slice(subcommandIndex + 1);
  if (!subcommand || !["branch", "diff", "log", "show", "status"].includes(subcommand)) {
    return false;
  }
  if (containsOption(arguments_, UNSAFE_GIT_SUBCOMMAND_OPTIONS)) return false;

  if (subcommand !== "branch") return true;
  if (arguments_.length === 0) return true;
  return arguments_.every(
    (argument) =>
      [
        "--all",
        "--list",
        "--remotes",
        "--show-current",
        "--verbose",
        "-a",
        "-l",
        "-r",
        "-v",
        "-vv",
      ].includes(argument) || argument.startsWith("--format="),
  );
}

function isInspectionArgv(command: string[]): boolean {
  const executable = command[0] ?? "";
  // Without an execution sandbox, a path named `rg` or `git` is not proof that
  // the trusted PATH command will run. Only classify bare executable names.
  if (executable.includes("/") || executable.includes("\\")) return false;
  const name = executableName(executable);
  if (SIMPLE_INSPECTION_COMMANDS.has(name)) {
    if (name !== "base64") return true;
    return !containsOption(command.slice(1), ["-o", "--output"]);
  }

  if (name === "find") {
    return !command.slice(1).some((argument) => UNSAFE_FIND_OPTIONS.has(argument));
  }

  if (name === "rg") {
    return (
      !command.slice(1).some((argument) => argument === "-z" || argument === "--search-zip") &&
      !containsOption(command.slice(1), UNSAFE_RG_OPTIONS)
    );
  }

  if (name === "git") return isReadOnlyGitCommand(command);

  if (name === "sed") {
    return (
      command.length >= 3 &&
      command.length <= 4 &&
      command[1] === "-n" &&
      /^(?:\d+,)?\d+p$/.test(command[2] ?? "")
    );
  }

  return process.platform === "linux" && (name === "numfmt" || name === "tac");
}

// Parse only the deliberately small shell subset that can prove inspection:
// literal words/quotes plus &&, ||, ;, | and newlines. Dynamic expansion,
// redirection, subshells, control flow and backgrounding all fail closed.
export function parseInspectionCommands(source: string): string[][] | undefined {
  const commands: string[][] = [];
  let command: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "single" | "double" | undefined;
  let trailingSeparatorAllowed = false;

  const finishWord = () => {
    if (!wordStarted) return;
    command.push(word);
    word = "";
    wordStarted = false;
  };
  const finishCommand = (): boolean => {
    finishWord();
    if (command.length === 0) return false;
    commands.push(command);
    command = [];
    return true;
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index] ?? "";

    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "$" || character === "`") {
        return undefined;
      } else if (character === "\\" && process.platform !== "win32") {
        const next = source[++index];
        if (next === undefined) return undefined;
        if (next !== "\n") word += next;
      } else {
        word += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      wordStarted = true;
      trailingSeparatorAllowed = false;
      continue;
    }
    if (character === "\\" && process.platform !== "win32") {
      const next = source[++index];
      if (next === undefined) return undefined;
      if (next !== "\n") {
        wordStarted = true;
        word += next;
        trailingSeparatorAllowed = false;
      }
      continue;
    }
    if (character === "$" || character === "`" || "<>(){}".includes(character)) {
      return undefined;
    }
    if (character === "#" && !wordStarted) return undefined;

    if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index++;
      if (!finishCommand()) return undefined;
      trailingSeparatorAllowed = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      continue;
    }
    if (character === ";") {
      if (!finishCommand()) return undefined;
      trailingSeparatorAllowed = true;
      continue;
    }
    if (character === "&") {
      if (source[index + 1] !== "&" || !finishCommand()) return undefined;
      index++;
      trailingSeparatorAllowed = false;
      continue;
    }
    if (character === "|") {
      const isOr = source[index + 1] === "|";
      if (!finishCommand()) return undefined;
      if (isOr) index++;
      trailingSeparatorAllowed = false;
      continue;
    }

    wordStarted = true;
    word += character;
    trailingSeparatorAllowed = false;
  }

  if (quote) return undefined;
  finishWord();
  if (command.length > 0) commands.push(command);
  return commands.length > 0 && (command.length > 0 || trailingSeparatorAllowed)
    ? commands
    : undefined;
}

export function classifyShellCommand(command: string): ShellCommandClassification {
  const commands = parseInspectionCommands(command);
  return commands?.length && commands.every(isInspectionArgv) ? "inspect" : "other";
}

export function isInspectionShellCommand(command: string): boolean {
  return classifyShellCommand(command) === "inspect";
}
