// Terminal output as a model should read it: no colour or cursor sequences, and
// a line redrawn with carriage returns (progress bars, spinners) keeps only what
// was drawn last. The user's own view of the output keeps the original.
// CSI, OSC (terminated by BEL or ST), and the remaining two-character escapes.
const CONTROL_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: parsing terminal output requires it
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function plainTerminalText(text: string): string {
  return text
    .replace(CONTROL_SEQUENCES, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      for (let index = parts.length - 1; index >= 0; index--) {
        if ((parts[index] ?? "") !== "") return parts[index] as string;
      }
      return "";
    })
    .join("\n");
}
