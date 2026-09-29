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

function clickTarget(meta: RefMeta | undefined): string | undefined {
  if (!meta) return undefined;
  if (matchesCommitLexicon(meta.name)) return `"${meta.name}" reads as a consequential action`;
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
}

export function classify({ tool, args, meta }: ClassifyInput): Classification {
  const declared = args.commit === true ? "declared consequential by the agent" : undefined;
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  const target = ref ? meta(ref) : undefined;
  const commit = (reason: string | undefined): Classification | undefined =>
    reason ? { scope: SCOPES.commit, reason } : undefined;

  switch (tool) {
    case "click": {
      return commit(declared ?? clickTarget(target)) ?? { scope: SCOPES.interact };
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
      const submit = submitRef ? clickTarget(meta(submitRef)) : undefined;
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
