// BD13: task-scoped supervision. Reading a page is free; changing one is asked
// about; committing to the outside world has its own scope per intent so a mode
// can pre-authorize a form submission without also pre-authorizing a purchase.
import type { PermissionMode, PermissionRule } from "@mu/core";
import { AUTONOMOUS_SUBMIT_INTENTS, permissionScopeForIntent } from "../contracts/intent.ts";
import type { BrowserScope } from "../policy/scopes.ts";

// These are projections of BROWSER_SCOPES, not names of their own. A rule naming a
// scope no tool ever produces matches nothing and silently falls through to the
// catch-all ask — which is exactly what `act: "browser:act"` did.
export const BROWSER_PERMISSION_SCOPES = {
  observe: "browser:observe",
  navigate: "browser:navigate",
  act: "browser:interact",
  upload: "browser:upload",
  takeover: "browser:takeover",
  disclose: "browser:disclose",
  unknown: "browser:unknown",
} as const satisfies Record<string, BrowserScope>;

export const BROWSER_PERMISSION_DEFAULTS: PermissionRule[] = [
  { permission: "*", pattern: "*", action: "ask" },
  // Observation and status are read-only and never leave the browser.
  { permission: BROWSER_PERMISSION_SCOPES.observe, pattern: "*", action: "allow" },
  { permission: "browser_status", pattern: "*", action: "allow" },
  // Handing control back to the user is always available; it is the safe direction.
  { permission: BROWSER_PERMISSION_SCOPES.takeover, pattern: "*", action: "allow" },
];

const denyEveryCommitment: PermissionRule[] = [
  "submit-form" as const,
  "send" as const,
  "purchase" as const,
  "delete" as const,
  "consent" as const,
  "account-change" as const,
].map((intent) => ({ permission: permissionScopeForIntent(intent), pattern: "*", action: "deny" }));

export const BROWSER_PERMISSION_MODES: PermissionMode[] = [
  {
    id: "confirm-submission",
    label: "confirm submit",
    description: "Browse and fill freely; ask before anything that commits.",
    rules: [
      { permission: BROWSER_PERMISSION_SCOPES.navigate, pattern: "*", action: "allow" },
      { permission: BROWSER_PERMISSION_SCOPES.act, pattern: "*", action: "allow" },
    ],
  },
  {
    id: "confirm-every-write",
    label: "confirm every write",
    description: "Ask before every change to a page, not only before commitments.",
    tone: "restrictive",
    rules: [
      { permission: BROWSER_PERMISSION_SCOPES.navigate, pattern: "*", action: "ask" },
      { permission: BROWSER_PERMISSION_SCOPES.act, pattern: "*", action: "ask" },
      { permission: BROWSER_PERMISSION_SCOPES.upload, pattern: "*", action: "ask" },
    ],
  },
  {
    id: "read-only",
    label: "read only",
    description: "Observe and navigate; refuse every change and every commitment.",
    tone: "restrictive",
    rules: [
      { permission: BROWSER_PERMISSION_SCOPES.navigate, pattern: "*", action: "allow" },
      { permission: BROWSER_PERMISSION_SCOPES.act, pattern: "*", action: "deny" },
      { permission: BROWSER_PERMISSION_SCOPES.upload, pattern: "*", action: "deny" },
      { permission: BROWSER_PERMISSION_SCOPES.unknown, pattern: "*", action: "deny" },
      ...denyEveryCommitment,
    ],
  },
  {
    id: "autonomous-submit",
    label: "autonomous submit",
    description:
      "Submit forms and send messages without asking. Purchases, deletions, consent and account changes still ask.",
    tone: "permissive",
    rules: [
      { permission: BROWSER_PERMISSION_SCOPES.navigate, pattern: "*", action: "allow" },
      { permission: BROWSER_PERMISSION_SCOPES.act, pattern: "*", action: "allow" },
      { permission: BROWSER_PERMISSION_SCOPES.upload, pattern: "*", action: "allow" },
      // SECURITY §9 pre-authorizes exactly these two, and nothing else.
      ...AUTONOMOUS_SUBMIT_INTENTS.map((intent) => ({
        permission: permissionScopeForIntent(intent),
        pattern: "*",
        action: "allow" as const,
      })),
    ],
  },
  {
    id: "yolo",
    label: "full access",
    description: "Allow every browser tool call without asking for permission.",
    tone: "unrestricted",
    rules: [{ permission: "*", pattern: "*", action: "allow" }],
  },
];

export const DEFAULT_BROWSER_PERMISSION_MODE = "confirm-submission";
