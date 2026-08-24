import { describe, expect, test } from "bun:test";
import { sampleFact } from "../testing/samples.ts";
import { taskAuthority, userAuthority } from "./authority.ts";
import {
  classifyNavigationUrl,
  createOriginPolicy,
  decideDisclosure,
  decideFrameInteraction,
  decideNavigation,
  decideRedirectChain,
  describeOrigin,
  isIdentityProviderOrigin,
  type OriginPolicy,
  withApprovedOrigin,
  withInsecureDisclosureOverride,
  withLoginTakeoverApproval,
} from "./origin.ts";

const TASK = "https://jobs.example.com/apply";

function policy(): OriginPolicy {
  return createOriginPolicy({ taskUrls: [TASK] }, taskAuthority());
}

describe("navigation scheme boundary", () => {
  test("attack: every non-web scheme the model might reach for is denied", () => {
    const targets = [
      "javascript:alert(document.cookie)",
      "data:text/html,<script>fetch('https://evil.example')</script>",
      "file:///etc/passwd",
      "file:///home/user/.ssh/id_rsa",
      "chrome://settings/passwords",
      "edge://settings/profiles",
      "chrome-extension://abcdefghijklmnop/options.html",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://jobs.example.com",
      "about:blank",
      "blob:https://jobs.example.com/1234",
      "ws://localhost:9222/devtools/browser",
      "ftp://files.example.com/",
      "vbscript:msgbox(1)",
    ];
    for (const target of targets) {
      const check = classifyNavigationUrl(target);
      expect(check.ok).toBe(false);
    }
  });

  test("attack: leading whitespace does not smuggle a javascript: URL past the check", () => {
    expect(classifyNavigationUrl("  javascript:alert(1)").ok).toBe(false);
    expect(classifyNavigationUrl("\n\tjavascript:alert(1)").ok).toBe(false);
  });

  test("http(s) targets are accepted and normalized", () => {
    const check = classifyNavigationUrl("HTTPS://Jobs.Example.com:443/apply?x=1#frag");
    expect(check).toMatchObject({ ok: true, origin: "https://jobs.example.com", secure: true });
  });

  test("garbage fails closed as malformed rather than parsing to an origin", () => {
    expect(classifyNavigationUrl("not a url").ok).toBe(false);
    expect(classifyNavigationUrl("").ok).toBe(false);
  });
});

describe("origin allow set", () => {
  test("the set is derived from the task URLs only", () => {
    expect(policy().allowed).toEqual(["https://jobs.example.com"]);
  });

  test("attack: forged authority cannot create or widen a policy", () => {
    const forged = { source: "user", scope: "task", grantedAt: 0 };
    expect(() => createOriginPolicy({ taskUrls: [TASK] }, forged)).toThrow();
    expect(() => withApprovedOrigin(policy(), "https://evil.example", forged)).toThrow();
    expect(() => withLoginTakeoverApproval(policy(), "https://evil.example", forged)).toThrow();
    expect(() => withInsecureDisclosureOverride(policy(), forged)).toThrow();
  });

  test("BD13: a task-scoped approval does not widen a policy scoped to another task", () => {
    const scoped = createOriginPolicy(
      { taskUrls: [TASK], context: { taskId: "t1" } },
      taskAuthority(),
    );
    const stale = userAuthority({ scope: "task", taskId: "t0" });
    expect(withApprovedOrigin(scoped, "https://evil.example", stale).allowed).toEqual(
      scoped.allowed,
    );
  });

  test("an approval from the current task widens the set", () => {
    const scoped = createOriginPolicy(
      { taskUrls: [TASK], context: { taskId: "t1" } },
      taskAuthority(),
    );
    const granted = withApprovedOrigin(
      scoped,
      "https://cdn.example.org",
      userAuthority({ scope: "task", taskId: "t1" }),
    );
    expect(granted.allowed).toContain("https://cdn.example.org");
  });
});

describe("navigation decisions", () => {
  test("same origin is allowed", () => {
    expect(decideNavigation(policy(), { to: `${TASK}/step-2`, from: TASK })).toMatchObject({
      kind: "allowed",
      reason: "same-origin",
    });
  });

  test("attack: a link to an unapproved origin asks instead of proceeding", () => {
    const decision = decideNavigation(policy(), {
      to: "https://tracker.evil.example/collect",
      from: TASK,
      label: "Continue your application",
    });
    expect(decision).toMatchObject({ kind: "ask", reason: "new-origin" });
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.from).toBe("https://jobs.example.com");
    expect(decision.message).toContain("https://tracker.evil.example");
  });

  test("attack: a redirect chain laundering an unapproved hop is caught mid-chain", () => {
    const decision = decideRedirectChain(
      policy(),
      [
        "https://jobs.example.com/out",
        "https://redirect.evil.example/r?u=jobs",
        "https://jobs.example.com/apply/step-2",
      ],
      { from: TASK },
    );
    expect(decision).toMatchObject({ kind: "ask", reason: "new-origin" });
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.origin).toBe("https://redirect.evil.example");
    expect(decision.message).toContain("redirect chain");
  });

  test("attack: a redirect chain ending in a denied scheme is denied", () => {
    const decision = decideRedirectChain(policy(), [
      "https://jobs.example.com/out",
      "file:///etc/passwd",
    ]);
    expect(decision.kind).toBe("denied");
  });

  test("a fully in-scope chain is allowed", () => {
    expect(
      decideRedirectChain(policy(), ["https://jobs.example.com/a", "https://jobs.example.com/b"])
        .kind,
    ).toBe("allowed");
  });
});

describe("identity providers", () => {
  test("known identity providers are recognised", () => {
    expect(isIdentityProviderOrigin("https://accounts.google.com")).toBe(true);
    expect(isIdentityProviderOrigin("https://acme.okta.com")).toBe(true);
    expect(isIdentityProviderOrigin("https://jobs.example.com")).toBe(false);
  });

  test("attack: an identity provider added to the allowed set is still gated on takeover", () => {
    const widened = withApprovedOrigin(policy(), "https://accounts.google.com", userAuthority());
    expect(decideNavigation(widened, { to: "https://accounts.google.com/signin" })).toMatchObject({
      kind: "ask",
      reason: "identity-provider",
    });
  });

  test("login takeover approval permits entry", () => {
    const approved = withLoginTakeoverApproval(
      policy(),
      "https://accounts.google.com",
      userAuthority(),
    );
    expect(decideNavigation(approved, { to: "https://accounts.google.com/signin" })).toMatchObject({
      kind: "allowed",
      reason: "login-approved",
    });
  });

  test("attack: login approval never becomes disclosure permission there", () => {
    const approved = withApprovedOrigin(
      withLoginTakeoverApproval(policy(), "https://accounts.google.com", userAuthority()),
      "https://accounts.google.com",
      userAuthority(),
    );
    expect(
      decideDisclosure(approved, {
        url: "https://accounts.google.com/signin/identifier",
        sensitivity: "personal",
      }),
    ).toMatchObject({ kind: "denied", reason: "identity-provider" });
  });
});

describe("cross-origin frames get their own decision", () => {
  test("attack: an embedded frame does not inherit the top-level approval", () => {
    const decision = decideFrameInteraction(policy(), {
      id: "frame-2",
      url: "https://widget.evil.example/form",
      origin: "https://widget.evil.example",
      crossOrigin: true,
    });
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.message).toContain("cross-origin frame");
  });

  test("a same-origin frame is allowed", () => {
    expect(
      decideFrameInteraction(policy(), {
        id: "frame-1",
        url: `${TASK}/embedded`,
        origin: "https://jobs.example.com",
        crossOrigin: false,
      }).kind,
    ).toBe("allowed");
  });
});

describe("lookalike origins are rendered in full", () => {
  test("a brand outside the registrable domain is flagged, never collapsed", () => {
    const display = describeOrigin("https://paypal.com.secure-login.example");
    expect(display.display).toBe("https://paypal.com.secure-login.example");
    expect(display.impersonatedBrands).toContain("paypal");
    expect(display.suspicious).toBe(true);
  });

  test("punycode labels are flagged", () => {
    const display = describeOrigin("https://xn--pypal-4ve.com");
    expect(display.punycode).toBe(true);
    expect(display.display).toBe("https://xn--pypal-4ve.com");
  });

  test("the genuine brand origin is not flagged", () => {
    expect(describeOrigin("https://paypal.com").suspicious).toBe(false);
  });

  test("a new-origin ask carries the full origin for the approval card", () => {
    const decision = decideNavigation(policy(), { to: "https://paypal.com.evil.example/pay" });
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error("unreachable");
    expect(decision.display.display).toBe("https://paypal.com.evil.example");
    expect(decision.display.warnings.length).toBeGreaterThan(0);
  });
});

describe("disclosure boundary", () => {
  test("attack: HTTP is denied for personal data", () => {
    const insecure = createOriginPolicy({ taskUrls: ["http://jobs.example.com"] }, taskAuthority());
    expect(
      decideDisclosure(insecure, { url: "http://jobs.example.com/apply", sensitivity: "personal" }),
    ).toMatchObject({ kind: "denied", reason: "insecure-transport" });
  });

  test("an explicit high-risk override downgrades HTTP to an ask, never to allow", () => {
    const insecure = createOriginPolicy({ taskUrls: ["http://jobs.example.com"] }, taskAuthority());
    const overridden = withInsecureDisclosureOverride(insecure, userAuthority());
    const decision = decideDisclosure(overridden, {
      url: "http://jobs.example.com/apply",
      sensitivity: "personal",
    });
    expect(decision.kind).toBe("ask");
  });

  test("public data over HTTP is not blocked by the transport rule", () => {
    const insecure = createOriginPolicy({ taskUrls: ["http://jobs.example.com"] }, taskAuthority());
    expect(
      decideDisclosure(insecure, { url: "http://jobs.example.com/apply", sensitivity: "public" })
        .kind,
    ).toBe("allowed");
  });

  test("attack: reaching an origin does not authorize telling it anything", () => {
    expect(
      decideDisclosure(policy(), {
        url: "https://analytics.evil.example/collect",
        sensitivity: "personal",
      }),
    ).toMatchObject({ kind: "denied", reason: "origin-not-allowed" });
  });

  test("attack: a restricted identifier is never disclosed anywhere", () => {
    expect(decideDisclosure(policy(), { url: TASK, sensitivity: "restricted" })).toMatchObject({
      kind: "denied",
      reason: "restricted-sensitivity",
    });
  });

  test("attack: an origin-restricted fact cannot leak to another allowed origin", () => {
    const widened = withApprovedOrigin(policy(), "https://other.example", userAuthority());
    const fact = sampleFact({ allowedOrigins: ["https://jobs.example.com"] });
    expect(
      decideDisclosure(widened, {
        url: "https://other.example/form",
        sensitivity: "personal",
        fact,
      }),
    ).toMatchObject({ kind: "denied", reason: "fact-origin-restricted" });
  });

  test("personal disclosure to an allowed HTTPS origin asks rather than proceeding", () => {
    expect(decideDisclosure(policy(), { url: TASK, sensitivity: "personal" }).kind).toBe("ask");
  });
});

describe("loopback is a secure context, the way the web platform means it", () => {
  const secure = (url: string) => {
    const check = classifyNavigationUrl(url);
    return check.ok ? check.secure : undefined;
  };

  // Not a concession for tests: a local server is the ordinary case for a fixture, a
  // dev build, or an internal tool, and traffic there never reaches a network.
  test("loopback in every spelling counts as secure", () => {
    for (const url of [
      "http://127.0.0.1:8080/apply",
      "http://127.5.6.7/apply",
      "http://localhost:3000/apply",
      "http://app.localhost/apply",
      "http://[::1]:9000/apply",
    ]) {
      expect({ url, secure: secure(url) }).toEqual({ url, secure: true });
    }
  });

  test("plaintext to anywhere else is still insecure", () => {
    for (const url of [
      "http://jobs.example.com/apply",
      "http://127.0.0.1.example.com/apply",
      "http://localhost.example.com/apply",
      "http://192.168.1.10/apply",
    ]) {
      expect({ url, secure: secure(url) }).toEqual({ url, secure: false });
    }
  });
});
