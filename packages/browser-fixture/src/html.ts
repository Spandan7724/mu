const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 1.5rem; max-width: 46rem; }
h1 { font-size: 1.4rem; }
fieldset { border: 1px solid currentColor; margin: 0 0 1rem; padding: 0.75rem 1rem; }
label { display: block; margin: 0.6rem 0 0.2rem; }
input, select, textarea { display: block; padding: 0.3rem; min-width: 18rem; }
button { padding: 0.4rem 0.9rem; margin-top: 0.8rem; }
.errors { border: 2px solid #b00; padding: 0.5rem 1rem; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.hostile { border: 1px dashed currentColor; padding: 0.5rem 1rem; margin: 1rem 0; }
iframe { width: 100%; height: 16rem; border: 1px solid currentColor; }
`;

export type PageOptions = {
  /** Stable machine identifier for the page, exposed as body[data-fixture-page]. */
  id: string;
  title: string;
  body: string;
  head?: string;
  status?: number;
  headers?: Record<string, string>;
};

export function renderPage(options: PageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(options.title)}</title>
<style>${STYLE}</style>
${options.head ?? ""}
</head>
<body data-fixture-page="${esc(options.id)}">
<h1>${esc(options.title)}</h1>
${options.body}
</body>
</html>`;
}

export function page(options: PageOptions): Response {
  return new Response(renderPage(options), {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...options.headers,
    },
  });
}

export function errorBanner(errors: string[]): string {
  if (errors.length === 0) return "";
  const items = errors.map((e) => `<li>${esc(e)}</li>`).join("");
  return `<div class="errors" role="alert" data-fixture-errors="${errors.length}">
<p>We could not accept this step.</p><ul>${items}</ul></div>`;
}

export type FieldOption = { value: string; label: string };

export function optionList(options: FieldOption[], selected?: string): string {
  return options
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.value === selected ? " selected" : ""}>${esc(o.label)}</option>`,
    )
    .join("");
}

export function textField(options: {
  name: string;
  label: string;
  type?: string;
  value?: string;
  required?: boolean;
  placeholder?: string;
  autocomplete?: string;
  extra?: string;
}): string {
  const id = `f-${options.name}`;
  const attrs = [
    `id="${esc(id)}"`,
    `name="${esc(options.name)}"`,
    `type="${esc(options.type ?? "text")}"`,
    `value="${esc(options.value ?? "")}"`,
    options.required ? "required" : "",
    options.placeholder ? `placeholder="${esc(options.placeholder)}"` : "",
    options.autocomplete ? `autocomplete="${esc(options.autocomplete)}"` : "",
    options.extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<label for="${esc(id)}">${esc(options.label)}${options.required ? " *" : ""}</label>
<input ${attrs}>`;
}

export function selectField(options: {
  name: string;
  label: string;
  options: FieldOption[];
  value?: string;
  required?: boolean;
}): string {
  const id = `f-${options.name}`;
  return `<label for="${esc(id)}">${esc(options.label)}${options.required ? " *" : ""}</label>
<select id="${esc(id)}" name="${esc(options.name)}"${options.required ? " required" : ""}>
${optionList(options.options, options.value)}
</select>`;
}

export function radioGroup(options: {
  name: string;
  legend: string;
  options: FieldOption[];
  value?: string;
  required?: boolean;
}): string {
  const inputs = options.options
    .map((o) => {
      const id = `f-${options.name}-${o.value}`;
      return `<label for="${esc(id)}"><input type="radio" id="${esc(id)}" name="${esc(options.name)}" value="${esc(o.value)}"${
        o.value === options.value ? " checked" : ""
      }${options.required ? " required" : ""}> ${esc(o.label)}</label>`;
    })
    .join("");
  return `<fieldset><legend>${esc(options.legend)}${options.required ? " *" : ""}</legend>${inputs}</fieldset>`;
}

export function checkboxField(options: {
  name: string;
  label: string;
  value?: string;
  checked?: boolean;
  required?: boolean;
}): string {
  const id = `f-${options.name}`;
  return `<label for="${esc(id)}"><input type="checkbox" id="${esc(id)}" name="${esc(options.name)}" value="${esc(
    options.value ?? "yes",
  )}"${options.checked ? " checked" : ""}${options.required ? " required" : ""}> ${esc(options.label)}</label>`;
}

/** ARIA switch backed by a hidden input so its value survives a real form POST. */
export function switchField(options: { name: string; label: string; on?: boolean }): string {
  const on = options.on === true;
  return `<div class="switch-row">
<span id="s-${esc(options.name)}-label">${esc(options.label)}</span>
<button type="button" role="switch" aria-checked="${on}" aria-labelledby="s-${esc(options.name)}-label"
  data-switch-for="${esc(options.name)}">${on ? "On" : "Off"}</button>
<input type="hidden" name="${esc(options.name)}" value="${on ? "yes" : "no"}">
</div>
<script>
(function () {
  var btn = document.querySelector('[data-switch-for="${esc(options.name)}"]');
  var input = btn.parentElement.querySelector('input[type=hidden]');
  btn.addEventListener('click', function () {
    var next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    btn.textContent = next ? 'On' : 'Off';
    input.value = next ? 'yes' : 'no';
  });
})();
</script>`;
}

export function comboboxField(options: {
  name: string;
  label: string;
  options: FieldOption[];
  value?: string;
}): string {
  const id = `f-${options.name}`;
  const listId = `l-${options.name}`;
  const items = options.options.map((o) => `<option value="${esc(o.value)}">`).join("");
  return `<label for="${esc(id)}">${esc(options.label)}</label>
<input id="${esc(id)}" name="${esc(options.name)}" role="combobox" aria-expanded="false"
  list="${esc(listId)}" value="${esc(options.value ?? "")}" autocomplete="off">
<datalist id="${esc(listId)}">${items}</datalist>`;
}

export function fileField(options: {
  name: string;
  label: string;
  accept?: string;
  multiple?: boolean;
  required?: boolean;
}): string {
  const id = `f-${options.name}`;
  return `<label for="${esc(id)}">${esc(options.label)}${options.required ? " *" : ""}</label>
<input type="file" id="${esc(id)}" name="${esc(options.name)}"${
    options.accept ? ` accept="${esc(options.accept)}"` : ""
  }${options.multiple ? " multiple" : ""}${options.required ? " required" : ""}>`;
}

export function definitionList(rows: [string, string][]): string {
  const items = rows
    .map(([key, value]) => `<dt>${esc(key)}</dt><dd data-field="${esc(key)}">${esc(value)}</dd>`)
    .join("");
  return `<dl>${items}</dl>`;
}

export function navList(links: [string, string][]): string {
  const items = links
    .map(([href, label]) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`)
    .join("");
  return `<nav><ul>${items}</ul></nav>`;
}
