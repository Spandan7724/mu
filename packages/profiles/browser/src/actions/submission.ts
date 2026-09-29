import type { Tab } from "../browser/tabs.ts";
import { resolveRef } from "../page/resolve.ts";

const MAX_LINES = 14;

// Runs on the element about to be activated: what its form (or dialog, or the
// nearest section holding fields) will send. A review page with no fields left is
// summarised by its text, head and tail, where attachments and totals usually sit.
const SUMMARIZE = `function (maxLines) {
  var el = this;
  var scope = el.form || (el.closest && el.closest("form,dialog,[role=dialog],[role=alertdialog]"));
  if (!scope) {
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.querySelector("input:not([type=hidden]),select,textarea,[contenteditable=''],[contenteditable=true]")) { scope = p; break; }
    }
  }
  if (!scope) return null;
  function clean(text, max) { return String(text || "").replace(/\\s+/g, " ").trim().slice(0, max); }
  function labelOf(f) {
    var text = f.getAttribute("aria-label");
    if (!text && f.labels && f.labels[0]) text = f.labels[0].innerText;
    var by = f.getAttribute("aria-labelledby");
    if (!text && by) text = by.split(" ").map(function (id) { var n = document.getElementById(id); return n ? n.innerText : ""; }).join(" ");
    return clean(text || f.getAttribute("placeholder") || f.name || f.id || f.tagName.toLowerCase(), 50);
  }
  var lines = [];
  var fields = scope.querySelectorAll("input,select,textarea,[contenteditable=''],[contenteditable=true]");
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], tag = f.tagName.toLowerCase(), type = (f.type || "").toLowerCase(), value = "";
    if (tag === "input" && /^(hidden|submit|button|reset|image)$/.test(type)) continue;
    if (type === "file") {
      value = Array.prototype.map.call(f.files || [], function (file) { return file.name; }).join(", ");
    } else if (f.getClientRects().length === 0) {
      continue;
    } else if (type === "checkbox" || type === "radio") {
      if (!f.checked) continue;
      value = type === "radio" ? clean((f.labels && f.labels[0] && f.labels[0].innerText) || f.value, 50) : "checked";
    } else if (tag === "select") {
      value = Array.prototype.filter.call(f.options, function (o) { return o.selected && o.value !== ""; }).map(function (o) { return clean(o.text, 50); }).join(", ");
    } else if (tag === "input" || tag === "textarea") {
      value = type === "password" ? (f.value ? "••••" : "") : clean(f.value, 80);
    } else {
      value = clean(f.innerText, 80);
    }
    if (!value) continue;
    lines.push(labelOf(f) + ": " + value);
    if (lines.length >= maxLines) { lines.push("…"); break; }
  }
  if (lines.length > 0) return { kind: "fields", lines: lines };
  var text = String(scope.innerText || "").split("\\n").map(function (line) { return clean(line, 100); })
    .filter(function (line, index, all) { return line && all.indexOf(line) === index; });
  if (text.length === 0) return null;
  if (text.length > maxLines) text = text.slice(0, maxLines - 6).concat(["…"], text.slice(-5));
  return { kind: "text", lines: text };
}`;

// Best effort: a page without a real form, or a slow one, yields nothing.
export async function submissionSummary(tab: Tab, ref: string): Promise<string[]> {
  const signal = AbortSignal.timeout(2_000);
  try {
    const target = await resolveRef(tab, ref, signal);
    const result = await target.session.send(
      "Runtime.callFunctionOn",
      {
        objectId: target.objectId,
        functionDeclaration: SUMMARIZE,
        arguments: [{ value: MAX_LINES }],
        returnByValue: true,
      },
      { signal, timeoutMs: 2_000 },
    );
    const value = result.result.value as { kind: "fields" | "text"; lines: string[] } | null;
    if (!value?.lines.length) return [];
    return [
      value.kind === "fields" ? "sends:" : "page being submitted shows:",
      ...value.lines.map((line) => `  ${line}`),
    ];
  } catch {
    return [];
  }
}
