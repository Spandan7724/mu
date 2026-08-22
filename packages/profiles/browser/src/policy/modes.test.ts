import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "@mu/core";
import { elementRefId } from "../contracts/primitives.ts";
import { sampleElement } from "../testing/samples.ts";
import { userAuthority } from "./authority.ts";
import {
  autonomousSubmitGrant,
  BROWSER_PERMISSION_MODES,
  browserPermissionRules,
  evaluateBrowserPermission,
  findFullAccessRules,
  isGrantActive,
} from "./modes.ts";
import { actPattern, NEVER_AUTO_ALLOWED_SCOPES, submitPattern } from "./scopes.ts";

const ORIGIN = "https://jobs.example.com";

function decide(input: Parameters<typeof evaluateBrowserPermission>[0]) {
  return evaluateBrowserPermission(input).action;
}

describe("permission modes", () => {
  // BD13 names three modes. `read-only` is additionally offered because it is strictly
  // more restrictive than any of them — it narrows authority, so it is not the kind of
  // expansion SECURITY §9 requires a new decision for.
  test("provides BD13's three modes plus read-only, and no full-access mode", () => {
    expect(BROWSER_PERMISSION_MODES).toEqual([
      "read-only",
      "confirm-submission",
      "confirm-every-write",
      "autonomous-submit",
    ]);
  });

  // SECURITY §9: there is no global full-access mode in v1. Guarded here because the
  // coding product has one and copying its convention into this domain would mean
  // unprompted purchases, sends and deletions on the user's signed-in accounts.
  test("no mode grants a blanket allow over every scope", () => {
    for (const mode of BROWSER_PERMISSION_MODES) {
      for (const scope of NEVER_AUTO_ALLOWED_SCOPES) {
        expect(
          decide({
            mode,
            scopes: [scope],
            pattern: "https://shop.example.com Buy",
            originApproved: true,
          }),
        ).not.toBe("allow");
      }
    }
  });

  test("read-only denies every write and every commitment", () => {
    for (const scope of ["browser:interact", "browser:disclose", "browser:upload"] as const) {
      expect(
        decide({ mode: "read-only", scopes: [scope], pattern: "*", originApproved: true }),
      ).toBe("deny");
    }
    expect(
      decide({
        mode: "read-only",
        scopes: ["browser:observe"],
        pattern: "*",
        originApproved: true,
      }),
    ).toBe("allow");
  });

  test("confirm-submission allows reversible interaction and asks before commitment", () => {
    expect(
      decide({
        mode: "confirm-submission",
        scopes: ["browser:interact"],
        pattern: actPattern(ORIGIN, sampleElement()),
      }),
    ).toBe("allow");
    expect(
      decide({
        mode: "confirm-submission",
        scopes: ["browser:submit"],
        pattern: submitPattern(ORIGIN, "submit-form"),
      }),
    ).toBe("ask");
  });

  test("confirm-every-write asks before an ordinary interaction too", () => {
    expect(
      decide({ mode: "confirm-every-write", scopes: ["browser:interact"], pattern: "x" }),
    ).toBe("ask");
    expect(decide({ mode: "confirm-every-write", scopes: ["browser:observe"], pattern: "x" })).toBe(
      "allow",
    );
  });

  test("a new origin always asks, in every mode", () => {
    for (const mode of BROWSER_PERMISSION_MODES) {
      expect(decide({ mode, scopes: ["browser:new-origin"], pattern: ORIGIN })).toBe("ask");
    }
  });
});

describe("autonomous-submit", () => {
  const grant = () => autonomousSubmitGrant([ORIGIN], userAuthority({ taskId: "t1" }));
  const context = { taskId: "t1" };

  test("pre-authorizes submit and send for the granted origins", () => {
    for (const scope of ["browser:submit", "browser:send"] as const) {
      expect(
        decide({
          mode: "autonomous-submit",
          scopes: [scope],
          pattern: `${ORIGIN} submit-form Submit application`,
          grant: grant(),
          context,
        }),
      ).toBe("allow");
    }
  });

  test("attack: purchase, delete and account-change stay ask under the same grant", () => {
    for (const scope of ["browser:purchase", "browser:delete", "browser:account-change"] as const) {
      const decision = evaluateBrowserPermission({
        mode: "autonomous-submit",
        scopes: [scope],
        pattern: `${ORIGIN} purchase Buy now`,
        grant: grant(),
        context,
      });
      expect(decision.action).toBe("ask");
    }
  });

  test("attack: consent is not part of the autonomous set", () => {
    expect(
      decide({
        mode: "autonomous-submit",
        scopes: ["browser:consent"],
        pattern: `${ORIGIN} consent I agree`,
        grant: grant(),
        context,
      }),
    ).toBe("ask");
  });

  test("attack: the grant does not reach an origin it did not name", () => {
    expect(
      decide({
        mode: "autonomous-submit",
        scopes: ["browser:submit"],
        pattern: "https://other.example submit-form Submit",
        grant: grant(),
        context,
      }),
    ).toBe("ask");
  });

  test("BD13: the grant expires with its task", () => {
    expect(isGrantActive(grant(), { taskId: "t1" })).toBe(true);
    expect(isGrantActive(grant(), { taskId: "t2" })).toBe(false);
    expect(
      decide({
        mode: "autonomous-submit",
        scopes: ["browser:submit"],
        pattern: `${ORIGIN} submit-form Submit`,
        grant: grant(),
        context: { taskId: "t2" },
      }),
    ).toBe("ask");
  });

  test("attack: a grant cannot be forged without an authority", () => {
    expect(() => autonomousSubmitGrant([ORIGIN], { source: "user" })).toThrow();
  });

  test("without a grant, autonomous-submit behaves like confirm-submission", () => {
    expect(
      browserPermissionRules("autonomous-submit").filter((r) => r.action === "allow").length,
    ).toBe(browserPermissionRules("confirm-submission").filter((r) => r.action === "allow").length);
  });
});

describe("clamps", () => {
  const fullAccess: PermissionRule[] = [{ permission: "browser:*", pattern: "*", action: "allow" }];

  test("attack: a smuggled browser:* allow rule cannot buy purchase authority", () => {
    const decision = evaluateBrowserPermission({
      mode: "confirm-submission",
      scopes: ["browser:purchase"],
      pattern: `${ORIGIN} purchase Buy now`,
      rules: fullAccess,
    });
    expect(decision.action).toBe("ask");
    expect(decision.clamped).toContain("never-auto-allowed");
  });

  test("attack: the same rule cannot buy delete or account-change authority", () => {
    for (const scope of ["browser:delete", "browser:account-change"] as const) {
      expect(
        evaluateBrowserPermission({
          mode: "confirm-submission",
          scopes: [scope],
          pattern: "*",
          rules: fullAccess,
        }).action,
      ).toBe("ask");
    }
  });

  test("a deny rule still wins, because clamps only tighten", () => {
    expect(
      decide({
        mode: "autonomous-submit",
        scopes: ["browser:submit"],
        pattern: `${ORIGIN} submit-form Submit`,
        grant: autonomousSubmitGrant([ORIGIN], userAuthority()),
        rules: [{ permission: "browser:submit", pattern: "*", action: "deny" }],
      }),
    ).toBe("deny");
  });

  test("unknown risk fails closed even where a rule allows", () => {
    const decision = evaluateBrowserPermission({
      mode: "confirm-submission",
      scopes: ["browser:interact"],
      pattern: `${ORIGIN} control`,
      unknownRisk: true,
    });
    expect(decision.action).toBe("ask");
    expect(decision.clamped).toContain("unknown-risk");
  });

  test("an unapproved origin fails closed even where a rule allows", () => {
    expect(
      evaluateBrowserPermission({
        mode: "confirm-submission",
        scopes: ["browser:interact"],
        pattern: "x",
        originApproved: false,
      }).action,
    ).toBe("ask");
  });

  test("configuration granting the never-auto-allowed scopes is detectable", () => {
    expect(findFullAccessRules(fullAccess)).toHaveLength(1);
    expect(findFullAccessRules(browserPermissionRules("confirm-submission"))).toHaveLength(0);
  });
});

describe("patterns cannot be widened by page text", () => {
  test("attack: a control accessibly named '*' does not become a wildcard pattern", () => {
    const hostile = sampleElement({
      ref: elementRefId("evil"),
      name: "*",
      label: "*",
      role: "button",
    });
    expect(actPattern(ORIGIN, hostile)).toBe(`${ORIGIN} control`);
  });

  test("attack: glob metacharacters in a label are stripped from the pattern", () => {
    const hostile = sampleElement({ name: "Submit *", label: "Submit *" });
    expect(submitPattern(ORIGIN, "submit-form", hostile)).toBe(`${ORIGIN} submit-form Submit`);
  });

  test("a sanitized pattern no longer matches a broad rule it was aiming at", () => {
    const hostile = sampleElement({ name: "*", label: "*", role: "button" });
    const pattern = actPattern(ORIGIN, hostile);
    expect(
      decide({
        mode: "confirm-every-write",
        scopes: ["browser:interact"],
        pattern,
        rules: [{ permission: "browser:interact", pattern: `${ORIGIN} *`, action: "ask" }],
      }),
    ).toBe("ask");
  });
});
