// BD13: task-scoped supervision. Reading a page is free; changing one is asked
// about; committing to the outside world has its own scope per intent so a mode
// can pre-authorize a form submission without also pre-authorizing a purchase.
import type { PermissionMode, PermissionRule } from "@mu/core";
import { AUTONOMOUS_SUBMIT_INTENTS, permissionScopeForIntent } from "../contracts/intent.ts";

export const BROWSER_PERMISSION_SCOPES = {
  observe: "browser:observe",
  navigate: "browser:navigate",
  act: "browser:act",
  upload: "browser:upload",
  takeover: "browser:takeover",
  disclose: "browser:disclose",
} as const;

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
];

// There is deliberately no global full-access mode. SECURITY.md §9: expanding the
// pre-authorized set requires a new BD entry and a security review, and v1 has none.
// The coding product's `yolo` does not translate here — an unprompted file edit is
// recoverable, an unprompted purchase, send or deletion on the user's signed-in
// account is not.

export const DEFAULT_BROWSER_PERMISSION_MODE = "confirm-submission";
