import type { Tab } from "../browser/tabs.ts";
import { resolveRef } from "../page/resolve.ts";

const MAX_LINES = 14;

// Runs on the element about to be activated: what its form (or dialog, or the
// nearest section whose fields hold something) will send, including recipient
// chips beside a field (Gmail's To). A review page with no fields left is
// summarised by its text, head and tail, where attachments and totals usually sit.
const SUMMARIZE = `function (maxLines) {
  var el = this;
  var FIELD = "input:not([type=hidden]),select,textarea,[contenteditable=''],[contenteditable=true]";
  var CHIP = "[role=option],[role=listitem],[data-hovercard-id],[email],[data-email]";
  var EMAIL = /[\\w.+-]+@[\\w-]+(\\.[\\w-]+)+/;
  function clean(text, max) { return String(text || "").replace(/\\s+/g, " ").trim().slice(0, max); }
  function visible(n) { return n.getClientRects().length > 0; }
  function labelOf(f) {
    var text = f.getAttribute("aria-label");
    if (!text && f.labels && f.labels[0]) text = f.labels[0].innerText;
    var by = f.getAttribute("aria-labelledby");
    if (!text && by) text = by.split(" ").map(function (id) { var n = document.getElementById(id); return n ? n.innerText : ""; }).join(" ");
    return clean(text || f.getAttribute("placeholder") || f.name || f.id || f.tagName.toLowerCase(), 50);
  }
  function chipText(c) {
    var email = ["data-hovercard-id", "email", "data-email", "title", "aria-label"]
      .map(function (a) { return c.getAttribute(a); }).concat([c.innerText])
      .map(function (v) { var m = EMAIL.exec(v || ""); return m ? m[0] : ""; })
      .filter(Boolean)[0];
    var name = clean(c.getAttribute("data-name") || c.innerText, 50);
    if (!email) return name;
    return name && name.toLowerCase().indexOf(email.toLowerCase()) < 0 ? name + " <" + email + ">" : email;
  }
  // Chips sit beside their recipient-style input, inside the nearest container that
  // holds no other field. Hidden chips count: Gmail hides the whole To row, chips
  // included, once another field has focus.
  function recipientField(f) {
    return f.tagName.toLowerCase() === "input" &&
      (f.getAttribute("role") === "combobox" || f.hasAttribute("aria-autocomplete") || f.hasAttribute("list"));
  }
  function chipsOf(f) {
    if (!recipientField(f)) return [];
    var popups = ["aria-controls", "aria-owns"].map(function (a) { return document.getElementById(f.getAttribute(a) || ""); }).filter(Boolean);
    var box = f;
    for (var k = 0; k < 5 && box.parentElement; k++) {
      box = box.parentElement;
      var others = Array.prototype.filter.call(box.querySelectorAll(FIELD), function (g) { return g !== f && visible(g); });
      if (others.length) break;
      var out = [];
      var found = box.querySelectorAll(CHIP);
      for (var i = 0; i < found.length; i++) {
        var c = found[i];
        if (popups.some(function (p) { return p.contains(c); })) continue;
        var outer = c.parentElement && c.parentElement.closest(CHIP);
        if (outer && box.contains(outer)) continue;
        var text = clean(chipText(c), 80);
        if (text && out.indexOf(text) < 0) out.push(text);
      }
      if (out.length) return out;
    }
    return [];
  }
  function fieldLines(scope) {
    var lines = [];
    var fields = scope.querySelectorAll(FIELD);
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i], tag = f.tagName.toLowerCase(), type = (f.type || "").toLowerCase(), value = "";
      if (tag === "input" && /^(submit|button|reset|image)$/.test(type)) continue;
      if (type === "file") {
        value = Array.prototype.map.call(f.files || [], function (file) { return file.name; }).join(", ");
      } else if (!visible(f)) {
        // A collapsed recipient row still sends its chips and any address typed but not yet turned into one.
        if (!recipientField(f)) continue;
        value = clean(chipsOf(f).concat(f.value.trim() ? [f.value] : []).join(", "), 240);
      } else if (type === "checkbox" || type === "radio") {
        if (!f.checked) continue;
        value = type === "radio" ? clean((f.labels && f.labels[0] && f.labels[0].innerText) || f.value, 50) : "checked";
      } else if (tag === "select") {
        value = Array.prototype.filter.call(f.options, function (o) { return o.selected && o.value !== ""; }).map(function (o) { return clean(o.text, 50); }).join(", ");
      } else if (tag === "input" || tag === "textarea") {
        value = type === "password" ? (f.value ? "••••" : "") : clean(f.value, 80);
        var chips = chipsOf(f);
        if (chips.length) value = clean(chips.concat(value ? [value] : []).join(", "), 240);
      } else {
        value = clean(f.innerText, 80);
      }
      if (!value) continue;
      lines.push(labelOf(f) + ": " + value);
      if (lines.length >= maxLines) { lines.push("…"); break; }
    }
    return lines;
  }
  var scope = el.form || (el.closest && el.closest("form,dialog,[role=dialog],[role=alertdialog]"));
  var lines = [];
  if (scope) {
    lines = fieldLines(scope);
  } else {
    // Widen until the fields hold something: a container that only wraps the button
    // and a hidden input says nothing about what is sent.
    for (var p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      if (!p.querySelector(FIELD)) continue;
      scope = scope || p;
      lines = fieldLines(p);
      if (lines.length > 0) { scope = p; break; }
    }
  }
  if (!scope) return null;
  if (lines.length > 0) return { kind: "fields", lines: lines };
  var text = String(scope.innerText || "").split("\\n").map(function (line) { return clean(line, 100); })
    .filter(function (line, index, all) { return line && all.indexOf(line) === index; });
  if (text.length === 0) return null;
  if (text.length > maxLines) text = text.slice(0, maxLines - 6).concat(["…"], text.slice(-5));
  return { kind: "text", lines: text };
}`;

export interface SubmissionContent {
  // `fields` are "Label: value" pairs; `text` is what the submitting region shows.
  kind: "fields" | "text";
  lines: string[];
}

// Best effort: a page without a real form, or a slow one, yields nothing.
export async function submissionContent(
  tab: Tab,
  ref: string,
): Promise<SubmissionContent | undefined> {
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
    const value = result.result.value as SubmissionContent | null;
    return value?.lines.length ? value : undefined;
  } catch {
    return undefined;
  }
}
