import type { SessionStore, SessionTree } from "@mu/core";

export interface ResumePickerItem {
  label: string;
  value: string;
}

export function sessionPickerLabel(tree: SessionTree | undefined, sessionId: string): string {
  const firstUserEntry = tree
    ?.activePath()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  if (
    !firstUserEntry ||
    firstUserEntry.type !== "message" ||
    firstUserEntry.message.role !== "user"
  ) {
    return sessionId;
  }

  const text = firstUserEntry.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || sessionId;
}

export async function resumePickerItems(
  store: Pick<SessionStore, "list" | "load">,
): Promise<ResumePickerItem[]> {
  const sessionIds = await store.list();
  return Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        return {
          label: sessionPickerLabel(await store.load(sessionId), sessionId),
          value: sessionId,
        };
      } catch {
        return { label: sessionId, value: sessionId };
      }
    }),
  );
}
