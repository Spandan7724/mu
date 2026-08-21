import type { ApplicantFact, Sensitivity } from "../contracts/applicant.ts";
import { factAllowsOrigin } from "../contracts/applicant.ts";
import { normalizeOrigin } from "../contracts/primitives.ts";
import type { BrowserFrame } from "../contracts/tabs.ts";
import { type AuthorityContext, assertPolicyAuthority, isAuthorityActive } from "./authority.ts";
import { assertNotUntrusted } from "./untrusted.ts";

// TOOLS.md: v1 navigation is http(s) only. Everything here is denied outright rather
// than asked about, because none of these targets is a web origin a user could
// meaningfully approve.
const DENIED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "chrome:",
  "chrome-search:",
  "chrome-untrusted:",
  "chrome-extension:",
  "chrome-devtools:",
  "devtools:",
  "edge:",
  "extension:",
  "moz-extension:",
  "ms-browser-extension:",
  "safari-extension:",
  "about:",
  "blob:",
  "filesystem:",
  "view-source:",
  "ws:",
  "wss:",
  "ftp:",
  "intent:",
  "vbscript:",
]);

export type NavigationUrlDenial =
  | "malformed-url"
  | "denied-scheme"
  | "browser-internal"
  | "opaque-origin";

export type NavigationUrlCheck =
  | { ok: true; url: string; origin: string; secure: boolean }
  | { ok: false; reason: NavigationUrlDenial; message: string };

function schemeOf(raw: string): string | undefined {
  const match = /^\s*([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw);
  return match?.[1] === undefined ? undefined : `${match[1].toLowerCase()}:`;
}

/** browser_navigate's scheme boundary. Fails closed on anything it cannot parse. */
export function classifyNavigationUrl(raw: string): NavigationUrlCheck {
  const scheme = schemeOf(raw);
  if (scheme !== undefined && DENIED_SCHEMES.has(scheme)) {
    return {
      ok: false,
      reason: scheme === "chrome:" || scheme === "edge:" ? "browser-internal" : "denied-scheme",
      message: `navigation to ${scheme} URLs is denied; browser_navigate accepts http(s) only`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed-url", message: "navigation target is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "denied-scheme",
      message: `navigation to ${parsed.protocol} URLs is denied; browser_navigate accepts http(s) only`,
    };
  }
  const origin = normalizeOrigin(parsed.href);
  if (origin === undefined) {
    return {
      ok: false,
      reason: "opaque-origin",
      message: "navigation target has no usable web origin",
    };
  }
  return { ok: true, url: parsed.href, origin, secure: parsed.protocol === "https:" };
}

// SECURITY §6: common identity providers are enterable only through an approved login
// takeover, and that approval never carries disclosure permission.
const IDENTITY_PROVIDER_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "login.microsoft.com",
  "appleid.apple.com",
  "idmsa.apple.com",
  "github.com/login",
  "login.okta.com",
  "signin.aws.amazon.com",
  "auth0.com",
  "login.yahoo.com",
  "www.facebook.com/login",
  "accounts.spotify.com",
  "id.atlassian.com",
  "login.salesforce.com",
  "sso.godaddy.com",
];

const IDENTITY_PROVIDER_SUFFIXES = [".okta.com", ".auth0.com", ".onelogin.com", ".duosecurity.com"];

export function isIdentityProviderOrigin(origin: string): boolean {
  const host = hostOf(origin);
  if (host === undefined) return false;
  if (IDENTITY_PROVIDER_HOSTS.some((entry) => entry === host || entry.startsWith(`${host}/`))) {
    return true;
  }
  return IDENTITY_PROVIDER_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function hostOf(origin: string): string | undefined {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

// Brands whose name appearing outside the registrable domain is the classic
// lookalike shape (paypal.com.secure-login.example). Detection is advisory: the
// approval surface always shows the whole origin either way.
const IMPERSONATED_BRANDS = [
  "paypal",
  "google",
  "gmail",
  "apple",
  "icloud",
  "microsoft",
  "outlook",
  "office365",
  "amazon",
  "netflix",
  "facebook",
  "instagram",
  "linkedin",
  "github",
  "coinbase",
  "binance",
  "stripe",
  "chase",
  "wellsfargo",
  "bankofamerica",
  "dropbox",
  "docusign",
];

const LATIN = /[a-z]/i;
function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) > 127) return true;
  }
  return false;
}

export interface OriginDisplay {
  origin: string;
  host: string;
  /** Always the whole origin. SECURITY §6 forbids collapsing it to a brand name. */
  display: string;
  punycode: boolean;
  mixedScript: boolean;
  impersonatedBrands: string[];
  suspicious: boolean;
  warnings: string[];
}

export function describeOrigin(origin: string): OriginDisplay {
  const host = hostOf(origin) ?? origin;
  const warnings: string[] = [];
  const labels = host.split(".");
  const punycode = labels.some((label) => label.startsWith("xn--"));
  if (punycode) warnings.push("host contains punycode labels and may imitate another name");

  const mixedScript = LATIN.test(host) && hasNonAscii(host);
  if (mixedScript) warnings.push("host mixes Latin and non-Latin characters");

  const registrable = labels.slice(-2).join(".");
  const impersonatedBrands = IMPERSONATED_BRANDS.filter(
    (brand) => host.includes(brand) && !registrable.startsWith(`${brand}.`),
  );
  for (const brand of impersonatedBrands) {
    warnings.push(`host contains "${brand}" outside its registrable domain`);
  }

  return {
    origin,
    host,
    display: origin,
    punycode,
    mixedScript,
    impersonatedBrands,
    suspicious: punycode || mixedScript || impersonatedBrands.length > 0,
    warnings,
  };
}

export interface OriginPolicy {
  /** Origins the task or explicit configuration made reachable. */
  readonly allowed: readonly string[];
  /** Origins an approved login takeover may enter; never a disclosure permission. */
  readonly loginApproved: readonly string[];
  /** SECURITY §6: HTTPS is the default requirement for personal-data disclosure. */
  readonly allowInsecureDisclosure: boolean;
  readonly context: AuthorityContext;
}

export interface OriginPolicyInit {
  taskUrls?: readonly string[] | undefined;
  configuredOrigins?: readonly string[] | undefined;
  allowInsecureDisclosure?: boolean | undefined;
  context?: AuthorityContext | undefined;
}

function collectOrigins(values: readonly string[]): string[] {
  const origins: string[] = [];
  for (const value of values) {
    const check = classifyNavigationUrl(value);
    if (check.ok && !origins.includes(check.origin)) origins.push(check.origin);
  }
  return origins;
}

// The allowed set is derived only from the task and explicit configuration, and the
// authority argument is what makes that structural: there is no code path that adds
// an origin without one.
export function createOriginPolicy(init: OriginPolicyInit, authority: unknown): OriginPolicy {
  assertPolicyAuthority(authority, "creating an origin policy");
  const allowed = collectOrigins([...(init.taskUrls ?? []), ...(init.configuredOrigins ?? [])]);
  return {
    allowed,
    loginApproved: [],
    allowInsecureDisclosure: init.allowInsecureDisclosure === true,
    context: init.context ?? {},
  };
}

export function withApprovedOrigin(
  policy: OriginPolicy,
  origin: string,
  authority: unknown,
): OriginPolicy {
  assertPolicyAuthority(authority, "allowing a new origin");
  assertNotUntrusted(origin, "an allowed origin");
  if (!isAuthorityActive(authority, policy.context)) return policy;
  const normalized = normalizeOrigin(origin);
  if (normalized === undefined || policy.allowed.includes(normalized)) return policy;
  return { ...policy, allowed: [...policy.allowed, normalized] };
}

export function withLoginTakeoverApproval(
  policy: OriginPolicy,
  origin: string,
  authority: unknown,
): OriginPolicy {
  assertPolicyAuthority(authority, "approving a login takeover");
  assertNotUntrusted(origin, "a login-approved origin");
  if (!isAuthorityActive(authority, policy.context)) return policy;
  const normalized = normalizeOrigin(origin);
  if (normalized === undefined || policy.loginApproved.includes(normalized)) return policy;
  return { ...policy, loginApproved: [...policy.loginApproved, normalized] };
}

export function withInsecureDisclosureOverride(
  policy: OriginPolicy,
  authority: unknown,
): OriginPolicy {
  assertPolicyAuthority(authority, "overriding the HTTPS disclosure requirement");
  if (!isAuthorityActive(authority, policy.context)) return policy;
  return { ...policy, allowInsecureDisclosure: true };
}

export function isOriginAllowed(policy: OriginPolicy, origin: string): boolean {
  return policy.allowed.includes(origin);
}

export type OriginDenial =
  | NavigationUrlDenial
  | "identity-provider-without-takeover"
  | "redirect-to-unapproved-origin";

export type OriginDecision =
  | {
      kind: "allowed";
      origin: string;
      url: string;
      reason: "same-origin" | "allowed-origin" | "login-approved";
      display: OriginDisplay;
    }
  | {
      kind: "ask";
      origin: string;
      url: string;
      reason: "new-origin" | "identity-provider";
      from?: string | undefined;
      label?: string | undefined;
      display: OriginDisplay;
      message: string;
    }
  | {
      kind: "denied";
      reason: OriginDenial;
      message: string;
      origin?: string | undefined;
      url?: string | undefined;
      display?: OriginDisplay | undefined;
    };

export interface NavigationRequest {
  to: string;
  from?: string | undefined;
  /** The link or control text that led here. Untrusted; shown, never trusted. */
  label?: string | undefined;
}

export function decideNavigation(policy: OriginPolicy, request: NavigationRequest): OriginDecision {
  const check = classifyNavigationUrl(request.to);
  if (!check.ok) return { kind: "denied", reason: check.reason, message: check.message };

  const display = describeOrigin(check.origin);
  const fromOrigin =
    request.from === undefined ? undefined : (normalizeOrigin(request.from) ?? undefined);

  if (isIdentityProviderOrigin(check.origin)) {
    if (policy.loginApproved.includes(check.origin)) {
      return {
        kind: "allowed",
        origin: check.origin,
        url: check.url,
        reason: "login-approved",
        display,
      };
    }
    return {
      kind: "ask",
      origin: check.origin,
      url: check.url,
      reason: "identity-provider",
      ...(fromOrigin === undefined ? {} : { from: fromOrigin }),
      ...(request.label === undefined ? {} : { label: request.label }),
      display,
      message: `${check.origin} is an identity provider; it may be entered only through an approved login takeover, which does not authorize disclosing anything there`,
    };
  }

  if (isOriginAllowed(policy, check.origin)) {
    return {
      kind: "allowed",
      origin: check.origin,
      url: check.url,
      reason: fromOrigin === check.origin ? "same-origin" : "allowed-origin",
      display,
    };
  }

  return {
    kind: "ask",
    origin: check.origin,
    url: check.url,
    reason: "new-origin",
    ...(fromOrigin === undefined ? {} : { from: fromOrigin }),
    ...(request.label === undefined ? {} : { label: request.label }),
    display,
    message: `${fromOrigin ?? "the current page"} is navigating to ${check.origin}${
      request.label === undefined ? "" : ` via "${request.label}"`
    }`,
  };
}

const DECISION_RANK: Record<OriginDecision["kind"], number> = {
  allowed: 0,
  ask: 1,
  denied: 2,
};

// SECURITY §6: intermediate hops are evaluated too, so a chain that launders an
// unapproved origin through an allowed landing page is not silently accepted.
export function decideRedirectChain(
  policy: OriginPolicy,
  chain: readonly string[],
  request: Omit<NavigationRequest, "to"> = {},
): OriginDecision {
  if (chain.length === 0) {
    return { kind: "denied", reason: "malformed-url", message: "redirect chain is empty" };
  }
  let worst: OriginDecision | undefined;
  let previous = request.from;
  for (const hop of chain) {
    const decision = decideNavigation(policy, {
      to: hop,
      ...(previous === undefined ? {} : { from: previous }),
      ...(request.label === undefined ? {} : { label: request.label }),
    });
    if (worst === undefined || DECISION_RANK[decision.kind] > DECISION_RANK[worst.kind]) {
      worst = decision;
    }
    if (decision.kind !== "denied") previous = decision.url;
  }
  const outcome = worst as OriginDecision;
  if (outcome.kind === "allowed" || chain.length === 1) return outcome;
  if (outcome.kind === "ask") {
    return {
      ...outcome,
      message: `${outcome.message} (reached through a redirect chain of ${chain.length} hops)`,
    };
  }
  return outcome;
}

// SECURITY §5: a cross-origin frame follows its own origin policy, not the top-level
// page's, so embedding never inherits an approval.
export function decideFrameInteraction(policy: OriginPolicy, frame: BrowserFrame): OriginDecision {
  const target = frame.origin ?? frame.url;
  const decision = decideNavigation(policy, { to: target });
  if (decision.kind !== "ask" || !frame.crossOrigin) return decision;
  return {
    ...decision,
    message: `${decision.message}; this is a cross-origin frame and needs its own decision`,
  };
}

export type DisclosureDenial =
  | "malformed-url"
  | "insecure-transport"
  | "origin-not-allowed"
  | "identity-provider"
  | "restricted-sensitivity"
  | "fact-origin-restricted";

export type DisclosureDecision =
  | { kind: "allowed"; origin: string; display: OriginDisplay }
  | { kind: "ask"; origin: string; display: OriginDisplay; reasons: string[] }
  | { kind: "denied"; reason: DisclosureDenial; message: string; origin?: string | undefined };

export interface DisclosureRequest {
  url: string;
  sensitivity: Sensitivity;
  fact?: ApplicantFact | undefined;
  fieldLabel?: string | undefined;
}

// SECURITY §6/§7. Disclosure is a separate axis from navigation: reaching an origin
// never implies permission to tell it anything.
export function decideDisclosure(
  policy: OriginPolicy,
  request: DisclosureRequest,
): DisclosureDecision {
  const check = classifyNavigationUrl(request.url);
  if (!check.ok) {
    return { kind: "denied", reason: "malformed-url", message: check.message };
  }
  const origin = check.origin;
  const display = describeOrigin(origin);

  if (request.sensitivity === "restricted") {
    return {
      kind: "denied",
      reason: "restricted-sensitivity",
      origin,
      message:
        "restricted identifiers are never disclosed by the browser agent; the user must enter them",
    };
  }

  if (isIdentityProviderOrigin(origin)) {
    return {
      kind: "denied",
      reason: "identity-provider",
      origin,
      message: `${origin} is an identity provider; approving a login takeover there does not authorize disclosing anything`,
    };
  }

  if (!isOriginAllowed(policy, origin)) {
    return {
      kind: "denied",
      reason: "origin-not-allowed",
      origin,
      message: `${origin} is not an allowed origin for this task; approve the origin before disclosing anything to it`,
    };
  }

  if (request.fact !== undefined && !factAllowsOrigin(request.fact, origin)) {
    return {
      kind: "denied",
      reason: "fact-origin-restricted",
      origin,
      message: `fact ${request.fact.id} is restricted to specific origins and ${origin} is not one of them`,
    };
  }

  const personal = request.sensitivity !== "public";
  if (!check.secure && personal) {
    if (!policy.allowInsecureDisclosure) {
      return {
        kind: "denied",
        reason: "insecure-transport",
        origin,
        message: `${origin} is not HTTPS; personal data is not disclosed over plaintext transport`,
      };
    }
    return {
      kind: "ask",
      origin,
      display,
      reasons: [
        "the destination is HTTP, so this disclosure is not protected in transit",
        ...display.warnings,
      ],
    };
  }

  if (personal || display.suspicious) {
    return {
      kind: "ask",
      origin,
      display,
      reasons: [
        ...(personal ? [`disclosing ${request.sensitivity} data to ${origin}`] : []),
        ...display.warnings,
      ],
    };
  }

  return { kind: "allowed", origin, display };
}
