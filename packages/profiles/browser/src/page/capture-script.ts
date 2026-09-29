// Runs inside the page (isolated world), once per frame. Returns
// { info: JSON string, els: Element[] } by reference; `els` holds the kept
// elements that need accessibility data, indexed by node.e.
export const CAPTURE_SCRIPT = String.raw`(function capture(opts) {
  var WIDGET_ROLES = {button:1,link:1,textbox:1,searchbox:1,checkbox:1,radio:1,combobox:1,
    menuitem:1,menuitemcheckbox:1,menuitemradio:1,option:1,slider:1,spinbutton:1,switch:1,tab:1,
    treeitem:1};
  var CONTAINER_ROLES = {dialog:1,alertdialog:1,navigation:1,main:1,banner:1,contentinfo:1,
    complementary:1,region:1,form:1,search:1,list:1,listbox:1,menu:1,menubar:1,tablist:1,tree:1,
    grid:1,table:1,toolbar:1,group:1,radiogroup:1,row:1,alert:1,status:1,tabpanel:1,article:1};
  var CONTAINER_TAGS = {nav:"navigation",main:"main",header:"banner",footer:"contentinfo",
    aside:"complementary",form:"form",table:"table",ul:"list",ol:"list",menu:"list",
    fieldset:"group",dialog:"dialog",section:"region",article:"article",tr:"row",details:"group"};
  var TEXT_TAGS = {h1:"heading",h2:"heading",h3:"heading",h4:"heading",h5:"heading",h6:"heading",
    p:"paragraph",li:"listitem",td:"cell",th:"columnheader",dt:"term",dd:"definition",
    caption:"caption",figcaption:"caption",legend:"legend",blockquote:"blockquote",pre:"code",
    label:"label",output:"status"};
  var NATIVE = /^(a|button|select|textarea|input|summary)$/;
  var OTP = /otp|one.?time|2fa|totp|verification.?code|mfa|security.?code/i;
  var vw = window.innerWidth, vh = window.innerHeight;
  var margin = opts.margin || 0, maxText = opts.maxText || 300;
  var nodes = [], els = [];
  var modal = -1;

  function hasOwnText(el) {
    for (var c = el.firstChild; c; c = c.nextSibling)
      if (c.nodeType === 3 && /\S/.test(c.nodeValue)) return true;
    return false;
  }

  function editableKind(el, tag) {
    if (tag === "input") {
      var type = (el.type || "text").toLowerCase();
      if (type === "password") return "secret";
      var hint = (el.autocomplete || "") + " " + (el.name || "") + " " + (el.id || "");
      if (/one-time-code/.test(el.autocomplete || "") || OTP.test(hint)) return "otp";
      if (/^(text|email|search|tel|url|number|date|datetime-local|month|week|time)$/.test(type)) return "text";
      return undefined;
    }
    if (tag === "textarea") return "text";
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return "rich";
    return undefined;
  }

  function appendText(sink, value) {
    var node = nodes[sink];
    var text = value.replace(/\s+/g, " ");
    if (!/\S/.test(text)) { if (node.raw && node.raw[node.raw.length - 1] !== " ") node.raw += " "; return; }
    node.raw = (node.raw || "") + text;
  }

  // Marks where an interactive child sits inside its text block's text.
  var MARK = "\u0001";

  function walk(el, parent, sink, parentPointer) {
    var tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return;
    if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert")) return;
    var style = getComputedStyle(el);
    if (style.display === "none") return;
    var visible = style.visibility !== "hidden" && style.visibility !== "collapse" &&
      (style.opacity !== "0" || tag === "input");
    var role = (el.getAttribute("role") || "").toLowerCase().split(" ")[0];
    var pointer = style.cursor === "pointer";
    var editable = editableKind(el, tag);
    var kind = "", why = "";
    if (tag === "iframe" || tag === "frame") kind = "f";
    else if ((tag === "a" && el.hasAttribute("href")) || (NATIVE.test(tag) && tag !== "a" && !(tag === "input" && el.type === "hidden"))) kind = "i";
    else if (role && WIDGET_ROLES[role]) kind = "i";
    else if (editable === "rich") kind = "i";
    else if (el.hasAttribute("onclick") || el.getAttribute("draggable") === "true") { kind = "i"; why = "c"; }
    else if (pointer && !parentPointer && tag !== "label") { kind = "i"; why = "c"; }
    else {
      var tabindex = el.getAttribute("tabindex");
      if (tabindex !== null && Number(tabindex) >= 0 && !CONTAINER_TAGS[tag]) { kind = "i"; why = "f"; }
    }
    if (!kind) {
      if (role && CONTAINER_ROLES[role]) kind = "c";
      else if (CONTAINER_TAGS[tag] && (tag !== "section" || el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby"))) kind = "c";
      else if (tag === "img" && el.getAttribute("alt")) kind = "t";
      else if (TEXT_TAGS[tag]) kind = "t";
    }
    if (tag === "dialog" && !el.open) return;
    // Inside an interactive element only nested controls matter; its text is its name.
    if (sink === -2 && kind !== "i" && kind !== "f") {
      walkChildren(el.shadowRoot || el, parent, -2, pointer);
      return;
    }
    var inline = style.display === "inline" || style.display === "contents";
    // Inline, non-semantic elements inside a text block contribute their text to it.
    if (!kind && sink >= 0 && inline) {
      walkChildren(el.shadowRoot || el, parent, sink, pointer);
      return;
    }
    if (!kind && hasOwnText(el)) kind = "t";
    var rect = el.getBoundingClientRect();
    var zeroSize = rect.width === 0 || rect.height === 0;
    var index = parent, childSink = -1;
    if (kind && visible && !(kind === "i" && zeroSize && tag !== "input")) {
      var node = {
        p: parent, k: kind, tag: tag,
        x: Math.round(rect.left), y: Math.round(rect.top),
        w: Math.round(rect.width), h: Math.round(rect.height),
        v: rect.bottom >= -margin && rect.top <= vh + margin && rect.right >= 0 && rect.left <= vw ? 1 : 0
      };
      if (role) node.role = role;
      else if (tag === "img") node.role = "img";
      else if (kind === "t") node.role = TEXT_TAGS[tag] || "text";
      else if (kind === "c") node.role = CONTAINER_TAGS[tag];
      if (/^h[1-6]$/.test(tag)) node.lvl = Number(tag[1]);
      if (kind === "i") {
        var label = (el.innerText || el.value || "").replace(/\s+/g, " ").trim() ||
          el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "";
        node.t = label.slice(0, 120);
        if (editable) node.ed = editable;
        if (editable === "rich") node.val = (el.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 2000);
        if (tag === "a" && el.href) node.href = el.href;
        if (why) node.cur = why;
        var form = el.form || (el.closest && el.closest("form"));
        if (form) {
          node.post = (form.getAttribute("method") || "get").toLowerCase() === "post" ? 1 : 0;
          var isSubmit = (tag === "button" && (!el.getAttribute("type") || el.type === "submit")) || (tag === "input" && (el.type === "submit" || el.type === "image"));
          if (isSubmit) node.sub = 1;
          else {
            var submitter = form.querySelector("button:not([type]),button[type=submit],input[type=submit]");
            if (submitter) node.fsub = (submitter.innerText || submitter.value || submitter.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60);
          }
        }
        var dlg = el.closest && el.closest("dialog,[role=dialog],[role=alertdialog]");
        if (dlg) {
          var labelled = dlg.getAttribute("aria-labelledby");
          var title = dlg.getAttribute("aria-label") || (labelled && document.getElementById(labelled) ? document.getElementById(labelled).innerText : "") || "";
          if (!title) { var h = dlg.querySelector("h1,h2,h3"); if (h) title = h.innerText; }
          node.dlg = title.replace(/\s+/g, " ").trim().slice(0, 80);
        }
        if (tag === "select") {
          node.opts = Array.prototype.slice.call(el.options, 0, 30).map(function (o) { return o.label || o.text; });
          node.optCount = el.options.length;
        }
      }
      var named = kind === "c" && (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ||
        tag === "fieldset" || tag === "dialog" || role === "dialog" || role === "alertdialog" ||
        tag === "table" || el.hasAttribute("title"));
      if (kind === "f") {
        node.cx = Math.round(rect.left + el.clientLeft + parseFloat(style.paddingLeft || "0"));
        node.cy = Math.round(rect.top + el.clientTop + parseFloat(style.paddingTop || "0"));
      }
      if (kind === "i" || kind === "f" || named) {
        node.e = els.length;
        els.push(el);
      }
      if ((tag === "dialog" && el.open && el.matches(":modal")) || el.getAttribute("aria-modal") === "true") modal = nodes.length;
      index = nodes.push(node) - 1;
      if (kind === "i") {
        childSink = -2;
        if (sink >= 0) appendText(sink, MARK);
      }
      if (kind === "c" && hasOwnText(el)) childSink = index;
      if (kind === "t") {
        childSink = index;
        if (tag === "img") node.raw = el.getAttribute("alt");
      }
    } else if (!kind && sink >= 0 && visible) {
      childSink = sink;
    } else if (sink === -2) {
      childSink = -2;
    }
    if (kind === "f" || (kind === "i" && editable)) return;
    walkChildren(el.shadowRoot || el, index, childSink, pointer);
  }

  function walkChildren(root, parent, sink, pointer) {
    for (var c = root.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (sink >= 0) appendText(sink, c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      if (c.tagName === "SLOT") {
        var assigned = c.assignedNodes({ flatten: true });
        if (assigned.length) {
          for (var i = 0; i < assigned.length; i++) {
            if (assigned[i].nodeType === 1) walk(assigned[i], parent, sink, pointer);
            else if (assigned[i].nodeType === 3 && sink >= 0) appendText(sink, assigned[i].nodeValue);
          }
        } else walkChildren(c, parent, sink, pointer);
        continue;
      }
      walk(c, parent, sink, pointer);
    }
  }

  if (document.body) walkChildren(document.body, -1, -1, false);
  for (var n = 0; n < nodes.length; n++) {
    var item = nodes[n];
    if (item.k !== "t" && !(item.k === "c" && item.raw)) continue;
    var full = (item.raw || "").trim();
    item.len = full.length;
    item.t = full.slice(0, maxText);
    delete item.raw;
  }
  var scroller = document.scrollingElement || document.documentElement;
  var info = {
    url: location.href, title: document.title,
    vw: vw, vh: vh,
    sx: Math.round(window.scrollX), sy: Math.round(window.scrollY),
    pw: scroller ? scroller.scrollWidth : vw, ph: scroller ? scroller.scrollHeight : vh,
    modal: modal, nodes: nodes
  };
  return { info: JSON.stringify(info), els: els };
})`;
