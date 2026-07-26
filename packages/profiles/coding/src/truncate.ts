export const MAX_OUTPUT_CHARS = 30_000;
export const MAX_OUTPUT_LINES = 1_000;

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

// Keeps the head and the tail, drops the middle, and says so — an unbounded
// tool result is a real failure mode for long files and chatty commands.
export function truncateOutput(
  text: string,
  maxChars = MAX_OUTPUT_CHARS,
  maxLines = MAX_OUTPUT_LINES,
): TruncationResult {
  const lines = text.split("\n");

  if (text.length <= maxChars && lines.length <= maxLines) {
    return { text, truncated: false };
  }

  if (lines.length > maxLines) {
    const head = lines.slice(0, Math.floor(maxLines / 2));
    const tail = lines.slice(-Math.floor(maxLines / 2));
    const dropped = lines.length - head.length - tail.length;
    const joined = `${head.join("\n")}\n\n… [${dropped} lines omitted] …\n\n${tail.join("\n")}`;
    return {
      text: joined.length > maxChars ? truncateChars(joined, maxChars) : joined,
      truncated: true,
    };
  }

  return { text: truncateChars(text, maxChars), truncated: true };
}

function truncateChars(text: string, maxChars: number): string {
  const half = Math.floor(maxChars / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n\n… [${dropped} characters omitted] …\n\n${text.slice(-half)}`;
}

export function withNotice(result: TruncationResult, what: string): string {
  return result.truncated
    ? `${result.text}\n\n[output truncated — ${what}. Narrow the request to see more.]`
    : result.text;
}
