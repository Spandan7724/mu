import { writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export interface SaveTranscriptOptions {
  cwd?: string;
  requestedPath?: string;
  now?: Date;
  // Leading segment of a generated filename; the product owns its own name.
  prefix?: string;
}

function unquotePath(path: string): string {
  const trimmed = path.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function timestampName(now: Date, prefix: string): string {
  return `${prefix}-transcript-${now.toISOString().replaceAll(/[:.]/g, "-")}.md`;
}

function withSuffix(path: string, suffix: number): string {
  return `${path.slice(0, -3)}-${suffix}.md`;
}

export function transcriptPath(options: SaveTranscriptOptions = {}): {
  path: string;
  generated: boolean;
} {
  const cwd = resolve(options.cwd ?? process.cwd());
  const requested = unquotePath(options.requestedPath ?? "");
  if (!requested) {
    return {
      path: resolve(cwd, timestampName(options.now ?? new Date(), options.prefix ?? "session")),
      generated: true,
    };
  }
  const extension = extname(requested);
  if (extension && extension.toLowerCase() !== ".md") {
    throw new Error("Transcript export paths must use the .md extension.");
  }
  const filename = extension ? requested : `${requested}.md`;
  return {
    path: isAbsolute(filename) ? resolve(filename) : resolve(cwd, filename),
    generated: false,
  };
}

export async function saveTranscriptMarkdown(
  markdown: string,
  options: SaveTranscriptOptions = {},
): Promise<{ path: string; displayPath: string }> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const destination = transcriptPath({ ...options, cwd });
  let path = destination.path;
  for (let suffix = 2; ; suffix += 1) {
    try {
      await writeFile(path, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const relativePath = relative(cwd, path);
      const outsideCwd = relativePath === ".." || relativePath.startsWith(`..${sep}`);
      return {
        path,
        displayPath: relativePath && !outsideCwd ? relativePath : path,
      };
    } catch (error) {
      if (
        destination.generated &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        path = withSuffix(destination.path, suffix);
        continue;
      }
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`Refusing to overwrite existing transcript: ${path}`);
      }
      throw error;
    }
  }
}
