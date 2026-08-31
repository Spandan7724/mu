import type { SessionStore, SessionTree } from "@mu/core";

export const SESSION_TITLE_MAX_LENGTH = 120;

export interface ResumePickerItem {
  label: string;
  value: string;
}

interface DatedResumePickerItem {
  item: ResumePickerItem;
  createdAt: number | undefined;
  position: number;
}

export function normalizeSessionTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sessionPickerLabel(tree: SessionTree | undefined, sessionId: string): string {
  const title = normalizeSessionTitle(tree?.header?.title ?? "");
  if (title) return title;

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

function sessionCreatedAt(tree: SessionTree | undefined): number | undefined {
  const createdAt = Date.parse(tree?.header?.createdAt ?? "");
  return Number.isFinite(createdAt) ? createdAt : undefined;
}

export async function resumePickerItems(
  store: Pick<SessionStore, "list" | "load">,
): Promise<ResumePickerItem[]> {
  const sessionIds = await store.list();
  const datedItems: DatedResumePickerItem[] = await Promise.all(
    sessionIds.map(async (sessionId, position) => {
      try {
        const tree = await store.load(sessionId);
        return {
          item: {
            label: sessionPickerLabel(tree, sessionId),
            value: sessionId,
          },
          createdAt: sessionCreatedAt(tree),
          position,
        };
      } catch {
        return {
          item: { label: sessionId, value: sessionId },
          createdAt: undefined,
          position,
        };
      }
    }),
  );
  return datedItems
    .sort((left, right) => {
      if (left.createdAt !== undefined && right.createdAt !== undefined) {
        return right.createdAt - left.createdAt || left.position - right.position;
      }
      if (left.createdAt !== undefined) return -1;
      if (right.createdAt !== undefined) return 1;
      return left.position - right.position;
    })
    .map(({ item }) => item);
}
