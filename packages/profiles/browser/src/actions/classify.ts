import { SCOPES } from "../agent/permissions.ts";
import type { RefMeta } from "../page/refs.ts";

// Words on a control that mean "this has effects outside the browser".
const COMMIT_LEXICON =
  /\b(send|submit|pay|payment|buy|purchase|place (your )?order|order now|checkout|check out|confirm|delete|remove|erase|trash|discard|post|publish|reply|transfer|wire|book|reserve|subscribe|unsubscribe|sign up|register|apply|save changes|donate|agree|accept (the )?terms|i agree|withdraw|cancel (my )?(order|subscription|account|booking)|close account|deactivate)\b/i;

// Controls that back out of something are never consequential themselves.
const SAFE_LEXICON = /^(cancel|close|no|back|dismiss|not now|keep|go back|never mind|×|x)$/i;

export interface Classification {
  scope: string;
  // Why the action is gated (shown in approval details); absent for plain interactions.
  reason?: string;
}

export function matchesCommitLexicon(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (SAFE_LEXICON.test(trimmed)) return false;
  return COMMIT_LEXICON.test(trimmed);
}

// On a link these words lead to the page where it happens ("Apply now" opens the
// application form, Gmail's script-driven "Reply" link opens the reply box);
// following a link that deletes or unsubscribes still acts.
const LINK_OPENER =
  /^\W*(apply|register|sign up|book|reserve|reply|post|publish|subscribe|donate|send|submit)\b/i;

// A price in a button's name: pressing it spends money, whatever the verb.
const MONEY = /[$€£¥₹]\s?\d|\d[\d,.]*\s?(usd|eur|gbp|inr|rs\.?)(\b|$)/i;
// Generic verbs that move a flow forward; consequential where the flow pays or buys.
const PROCEED =
  /^\W*(continue|next|proceed|complete|finish|confirm|done|submit|go|review|place)\b/i;
const PAYING_PAGE =
  /checkout|payment|\bpay\b|billing|purchase|place-?order|order[-/](review|confirm)|transfer|donat/i;

export interface PageContext {
  url: string;
  title: string;
}

// How a consequential action reads afterwards. The gate and the ledger treat every
// commit alike; a record of an unattended run only stands out for the action that
// finished the job, not the steps leading to it (Checkout, Continue, a login) or an
// action only the model flagged (Add to cart).
export type CommitStrength = "final" | "step";

const FINAL_LEXICON =
  /\b(send|submit|pay|buy|purchase|place (your )?order|order now|delete|erase|trash|discard|post|publish|transfer|wire|book|reserve|subscribe|unsubscribe|sign up|register|confirm|save changes|donate|accept (the )?terms|i agree|withdraw|cancel (my )?(order|subscription|account|booking)|close account|deactivate)\b/i;
const FINISHING = /^\W*(finish|complete|confirm|place|pay|submit|done)\b/i;
// A page reporting that the job is done.
const CONFIRMED =
  /\b(thank you|thanks for|confirmed|confirmation|complete|completed|success|successful|submitted|sent)\b/i;

// Creating an account is final even though its form carries a password.
const SIGN_UP = /\b(sign up|register|create (an |your )?account|join)\b/i;

export function commitStrength(
  names: (string | undefined)[],
  before: PageContext,
  after?: PageContext,
  credentials = false,
): CommitStrength {
  // Signing in only moves the task along, whatever the button says or the next page
  // ("logged in successfully") reports.
  if (credentials && !names.some((name) => name && SIGN_UP.test(name))) return "step";
  const paying = PAYING_PAGE.test(before.url) || PAYING_PAGE.test(before.title);
  for (const name of names) {
    const trimmed = name?.trim();
    if (!trimmed || SAFE_LEXICON.test(trimmed)) continue;
    if (MONEY.test(trimmed) || FINAL_LEXICON.test(trimmed)) return "final";
    if (paying && FINISHING.test(trimmed)) return "final";
  }
  if (after && after.url !== before.url) {
    let path = "";
    try {
      path = new URL(after.url).pathname.replace(/[-_/.]+/g, " ");
    } catch {}
    if (CONFIRMED.test(path) || CONFIRMED.test(after.title)) return "final";
  }
  return "step";
}

function clickTarget(meta: RefMeta | undefined, page?: PageContext): string | undefined {
  if (!meta) return undefined;
  if (MONEY.test(meta.name)) return `"${meta.name}" names an amount of money`;
  if (
    page &&
    PROCEED.test(meta.name) &&
    !SAFE_LEXICON.test(meta.name.trim()) &&
    (PAYING_PAGE.test(page.url) || PAYING_PAGE.test(page.title))
  )
    return `"${meta.name}" moves a checkout or payment forward`;
  const link = meta.link || meta.role === "link";
  if (matchesCommitLexicon(meta.name) && !(link && LINK_OPENER.test(meta.name)))
    return `"${meta.name}" reads as a consequential action`;
  if (meta.form?.submit && meta.form.post) return "it submits a form that posts data";
  if (
    meta.dialogTitle &&
    matchesCommitLexicon(meta.dialogTitle) &&
    !SAFE_LEXICON.test(meta.name.trim())
  ) {
    return `it is in the dialog "${meta.dialogTitle}"`;
  }
  return undefined;
}

// Enter in a field submits its form.
// Enter submits a form only from a plain field of a form with a real submit button
// (implicit submission); in comboboxes it picks a suggestion (Gmail's To field), and
// in multi-line editors it adds a line.
const NON_SUBMITTING_ROLES = new Set(["combobox", "listbox", "searchbox"]);

function formSubmit(meta: RefMeta | undefined): string | undefined {
  if (!meta?.form?.submitLabel) return undefined;
  if (NON_SUBMITTING_ROLES.has(meta.role) || meta.editable === "rich") return undefined;
  if (matchesCommitLexicon(meta.form.submitLabel)) {
    return `Enter submits the form ("${meta.form.submitLabel}")`;
  }
  if (meta.form.post) return `Enter submits a form that posts data ("${meta.form.submitLabel}")`;
  return undefined;
}

export interface ClassifyInput {
  tool: string;
  args: Record<string, unknown>;
  meta: (ref: string) => RefMeta | undefined;
  page?: PageContext | undefined;
}

export function classify({ tool, args, meta, page }: ClassifyInput): Classification {
  const declared = args.commit === true ? "declared consequential by the agent" : undefined;
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  const target = ref ? meta(ref) : undefined;
  const commit = (reason: string | undefined): Classification | undefined =>
    reason ? { scope: SCOPES.commit, reason } : undefined;

  switch (tool) {
    case "click": {
      return commit(declared ?? clickTarget(target, page)) ?? { scope: SCOPES.interact };
    }
    case "click_xy":
      return commit(declared) ?? { scope: SCOPES.interact };
    case "type": {
      if (target?.editable === "secret" || target?.editable === "otp") {
        return {
          scope: SCOPES.secret,
          reason: `typing into a ${target.editable === "otp" ? "one-time code" : "password"} field`,
        };
      }
      return (
        commit(declared ?? (args.submit === true ? formSubmit(target) : undefined)) ?? {
          scope: SCOPES.interact,
        }
      );
    }
    case "press": {
      const keys = typeof args.keys === "string" ? args.keys : "";
      const enter = /(^|\+)\s*(enter|return)\s*$/i.test(keys);
      return (
        commit(declared ?? (enter ? formSubmit(target) : undefined)) ?? { scope: SCOPES.interact }
      );
    }
    case "fill_form": {
      const fields = Array.isArray(args.fields) ? (args.fields as { ref?: unknown }[]) : [];
      const secret = fields
        .map((field) => (typeof field.ref === "string" ? meta(field.ref) : undefined))
        .find((field) => field?.editable === "secret" || field?.editable === "otp");
      const submitRef = typeof args.submitRef === "string" ? args.submitRef : undefined;
      const submit = submitRef ? clickTarget(meta(submitRef), page) : undefined;
      if (declared || submit)
        return { scope: SCOPES.commit, reason: declared ?? `submitting: ${submit}` };
      if (secret)
        return { scope: SCOPES.secret, reason: "the form includes a password or one-time code" };
      return { scope: SCOPES.interact };
    }
    case "select":
      return commit(declared) ?? { scope: SCOPES.interact };
    default:
      return { scope: SCOPES.interact };
  }
}
