import { describe, expect, test } from "bun:test";
import {
  assertPolicyAuthority,
  configurationAuthority,
  isAuthorityActive,
  isPolicyAuthority,
  type PolicyAuthority,
  taskAuthority,
  UntrustedAuthorityError,
  userAuthority,
} from "./authority.ts";

describe("policy authority", () => {
  test("minted authority is recognised", () => {
    expect(isPolicyAuthority(userAuthority())).toBe(true);
    expect(isPolicyAuthority(taskAuthority())).toBe(true);
    expect(isPolicyAuthority(configurationAuthority())).toBe(true);
  });

  test("attack: an object literal shaped like an approval is not an approval", () => {
    const forged = {
      source: "user",
      scope: "task",
      grantedAt: 0,
    } as unknown as PolicyAuthority;
    expect(isPolicyAuthority(forged)).toBe(false);
    expect(() => assertPolicyAuthority(forged, "allowing an origin")).toThrow(
      UntrustedAuthorityError,
    );
  });

  test("attack: authority cannot survive serialization, so it cannot arrive as data", () => {
    const revived = JSON.parse(JSON.stringify(userAuthority())) as PolicyAuthority;
    expect(revived.source).toBe("user");
    expect(isPolicyAuthority(revived)).toBe(false);
  });

  test("attack: authority cannot be cloned out of a trusted grant", () => {
    const clone = { ...userAuthority() };
    expect(isPolicyAuthority(clone)).toBe(false);
  });

  test("BD13: a task-scoped grant is inactive outside its task", () => {
    const authority = userAuthority({ scope: "task", taskId: "task-1" });
    expect(isAuthorityActive(authority, { taskId: "task-1" })).toBe(true);
    expect(isAuthorityActive(authority, { taskId: "task-2" })).toBe(false);
    expect(isAuthorityActive(authority, {})).toBe(false);
  });

  test("BD13: a session-scoped grant is inactive in another session", () => {
    const authority = userAuthority({ scope: "session", sessionId: "s1" });
    expect(isAuthorityActive(authority, { sessionId: "s1" })).toBe(true);
    expect(isAuthorityActive(authority, { sessionId: "s2" })).toBe(false);
  });

  test("a forged authority is never active", () => {
    expect(isAuthorityActive({ scope: "task" } as unknown as PolicyAuthority, {})).toBe(false);
  });
});
