import type { ForkedCommandData, ForkPoint } from "mu";

export interface ForkPickerItem {
  label: string;
  description: string;
  value: string;
}

export function forkPickerItems(points: readonly ForkPoint[]): ForkPickerItem[] {
  return [
    { label: "here", description: "copy the whole conversation", value: "here" },
    ...points.map((point) => ({
      label: point.prompt.replace(/\s+/g, " ").trim() || "(empty prompt)",
      description: "before this prompt",
      value: point.id,
    })),
  ];
}

export function isForkedCommandData(data: unknown): data is ForkedCommandData {
  if (typeof data !== "object" || data === null) return false;
  const value = data as Record<string, unknown>;
  return (
    value.kind === "forked" &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.sourceSessionId === "string" &&
    (value.prompt === undefined || typeof value.prompt === "string")
  );
}

export function forkedNotice(data: ForkedCommandData): string {
  return `forked into ${data.sessionId} · ${data.sourceSessionId} is unchanged in /resume`;
}
