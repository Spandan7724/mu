import type { RecordedField, RecordedFile } from "./types.ts";

export const SESSION_COOKIE = "mu_fixture_sid";

export type ApplySession = {
  id: string;
  variant: string;
  step: number;
  fields: RecordedField[];
  files: RecordedFile[];
  /** Counts POSTs per path so a variant can fail the first attempt and accept the second. */
  attempts: Record<string, number>;
  authenticated: boolean;
  mfaPassed: boolean;
  captchaPassed: boolean;
};

function newId(): string {
  return `fix_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export class SessionStore {
  #sessions = new Map<string, ApplySession>();

  create(variant: string): ApplySession {
    const session: ApplySession = {
      id: newId(),
      variant,
      step: 1,
      fields: [],
      files: [],
      attempts: {},
      authenticated: false,
      mfaPassed: false,
      captchaPassed: false,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): ApplySession | undefined {
    return id === undefined ? undefined : this.#sessions.get(id);
  }

  /** Replaces every prior value for these names, so re-submitting a step is not additive. */
  merge(session: ApplySession, fields: RecordedField[], files: RecordedFile[]): void {
    const names = new Set(fields.map((f) => f.name));
    session.fields = session.fields.filter((f) => !names.has(f.name));
    session.fields.push(...fields);
    const fileFields = new Set(files.map((f) => f.field));
    session.files = session.files.filter((f) => !fileFields.has(f.field));
    session.files.push(...files);
  }

  attempt(session: ApplySession, key: string): number {
    const next = (session.attempts[key] ?? 0) + 1;
    session.attempts[key] = next;
    return next;
  }

  clear(): void {
    this.#sessions.clear();
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export function sessionCookieHeader(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; SameSite=Lax; HttpOnly`;
}
