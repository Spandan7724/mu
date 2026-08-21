// BD11 made structural. Every function that widens Mu's authority — allowing an
// origin, approving a login takeover, overriding the HTTPS requirement — demands a
// PolicyAuthority. Authority is held in a module-private WeakSet rather than in a
// field, so it cannot be forged from an object literal, revived from JSON, or
// reconstructed from anything a page, a tool result, or a downloaded file produced.
// Page text can therefore describe an approval but can never be one.

export type AuthoritySource = "user" | "task-configuration" | "local-policy";

export type AuthorityScope = "task" | "session";

export interface PolicyAuthority {
  readonly source: AuthoritySource;
  readonly scope: AuthorityScope;
  readonly grantedAt: number;
  readonly taskId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly reason?: string | undefined;
}

const granted = new WeakSet<PolicyAuthority>();

export interface AuthorityInit {
  scope?: AuthorityScope | undefined;
  grantedAt?: number | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
  reason?: string | undefined;
}

function mint(source: AuthoritySource, init: AuthorityInit): PolicyAuthority {
  const authority: PolicyAuthority = Object.freeze({
    source,
    scope: init.scope ?? "task",
    grantedAt: init.grantedAt ?? 0,
    ...(init.taskId === undefined ? {} : { taskId: init.taskId }),
    ...(init.sessionId === undefined ? {} : { sessionId: init.sessionId }),
    ...(init.reason === undefined ? {} : { reason: init.reason }),
  });
  granted.add(authority);
  return authority;
}

/** The user answered an approval prompt or typed the instruction. */
export function userAuthority(init: AuthorityInit = {}): PolicyAuthority {
  return mint("user", init);
}

/** The origin or override came from the task the user started. */
export function taskAuthority(init: AuthorityInit = {}): PolicyAuthority {
  return mint("task-configuration", init);
}

/** A trusted local configuration file the runtime loaded and validated. */
export function configurationAuthority(init: AuthorityInit = {}): PolicyAuthority {
  return mint("local-policy", init);
}

export function isPolicyAuthority(value: unknown): value is PolicyAuthority {
  return typeof value === "object" && value !== null && granted.has(value as PolicyAuthority);
}

export class UntrustedAuthorityError extends Error {
  constructor(what: string) {
    super(
      `${what} requires an authority minted from a user decision, the task, or local configuration; page content and tool results cannot produce one`,
    );
    this.name = "UntrustedAuthorityError";
  }
}

export function assertPolicyAuthority(
  value: unknown,
  what: string,
): asserts value is PolicyAuthority {
  if (!isPolicyAuthority(value)) throw new UntrustedAuthorityError(what);
}

// BD13: elevated authority expires with its declared task/session scope and is never a
// persisted global preference, so an authority that does not name the scope it is being
// used in is inactive rather than assumed valid.
export interface AuthorityContext {
  taskId?: string | undefined;
  sessionId?: string | undefined;
}

export function isAuthorityActive(
  authority: PolicyAuthority,
  context: AuthorityContext = {},
): boolean {
  if (!isPolicyAuthority(authority)) return false;
  if (authority.scope === "task") {
    if (authority.taskId === undefined) return context.taskId === undefined;
    return authority.taskId === context.taskId;
  }
  if (authority.sessionId === undefined) return context.sessionId === undefined;
  return authority.sessionId === context.sessionId;
}
