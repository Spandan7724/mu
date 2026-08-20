import { parseForm } from "../form.ts";
import {
  checkboxField,
  comboboxField,
  esc,
  fileField,
  page,
  radioGroup,
  selectField,
  switchField,
  textField,
} from "../html.ts";
import type { RouteTable } from "../router.ts";
import { finishSubmission } from "./outcomes.ts";

const SIZES = [
  { value: "", label: "Select a size" },
  { value: "s", label: "Small" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Large" },
];

export const fieldRoutes: RouteTable = {
  "GET /fields/all": () =>
    page({
      id: "fields-all",
      title: "Every field type",
      body: `<p>One control of every type this product claims to drive, each with a proper label.</p>
<form method="post" action="/fields/all" enctype="multipart/form-data" novalidate>
${textField({ name: "plain_text", label: "Plain text" })}
${textField({ name: "email", label: "Email", type: "email" })}
${textField({ name: "telephone", label: "Telephone", type: "tel" })}
${textField({ name: "quantity", label: "Quantity", type: "number", extra: 'min="0" max="99"' })}
${textField({ name: "start_date", label: "Start date", type: "date" })}
${textField({ name: "homepage", label: "Homepage", type: "url" })}
${textField({ name: "secret", label: "Password", type: "password", autocomplete: "current-password" })}
<label for="f-notes">Notes</label>
<textarea id="f-notes" name="notes" rows="3"></textarea>
${selectField({ name: "size", label: "Size", options: SIZES })}
<label for="f-tags">Tags (multi-select)</label>
<select id="f-tags" name="tags" multiple size="3">
<option value="alpha">Alpha</option><option value="beta">Beta</option><option value="gamma">Gamma</option>
</select>
${comboboxField({
  name: "city",
  label: "City",
  options: [
    { value: "Springfield", label: "Springfield" },
    { value: "Shelbyville", label: "Shelbyville" },
  ],
})}
${radioGroup({
  name: "shift",
  legend: "Shift",
  options: [
    { value: "day", label: "Day" },
    { value: "night", label: "Night" },
  ],
})}
${checkboxField({ name: "newsletter", label: "Send me updates" })}
<fieldset><legend>Interests (checkbox group)</legend>
${checkboxField({ name: "interests", label: "Backend", value: "backend" })}
${checkboxField({ name: "interests", label: "Frontend", value: "frontend" })}
${checkboxField({ name: "interests", label: "Infrastructure", value: "infra" })}
</fieldset>
${switchField({ name: "notifications", label: "Enable notifications" })}
${fileField({ name: "attachment", label: "Attachment" })}
<button type="submit">Save answers</button>
</form>`,
    }),

  "POST /fields/all": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/fields/all",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "GET /fields/poor-markup": () =>
    page({
      id: "fields-poor-markup",
      title: "Deliberately poor markup",
      body: `<p>Nothing on this page is accidental. Every control here is hard to name correctly.</p>
<form method="post" action="/fields/poor-markup" enctype="multipart/form-data" novalidate>

<!-- no label, no placeholder, no aria-label: only positional context -->
<div>Contact</div>
<input name="unlabelled_contact">

<!-- placeholder only -->
<input name="placeholder_only" placeholder="Your full name">

<!-- two different inputs sharing the same visible label text -->
<label for="f-dup-a">Reference</label>
<input id="f-dup-a" name="reference_primary">
<label for="f-dup-b">Reference</label>
<input id="f-dup-b" name="reference_secondary">

<!-- label points at a control that does not exist -->
<label for="f-missing">Employee number</label>
<input name="employee_number">

<!-- visually hidden but focusable and submitted -->
<label class="visually-hidden" for="f-hidden-visually">Internal note</label>
<input class="visually-hidden" id="f-hidden-visually" name="internal_note" value="">

<!-- title attribute is the only accessible name -->
<input name="title_named" title="Preferred pronouns">

<!-- a div acting as a text box -->
<div role="textbox" contenteditable="true" aria-label="Freeform answer" id="fake-textbox"></div>
<input type="hidden" name="freeform_answer" value="">

<!-- a div acting as a button -->
<div role="button" tabindex="0" id="fake-submit">Send it</div>
<button type="submit" class="visually-hidden">Submit</button>
</form>
<script>
(function () {
  var box = document.getElementById('fake-textbox');
  var mirror = document.querySelector('input[name=freeform_answer]');
  box.addEventListener('input', function () { mirror.value = box.textContent; });
  document.getElementById('fake-submit').addEventListener('click', function () {
    document.forms[0].submit();
  });
})();
</script>`,
    }),

  "POST /fields/poor-markup": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/fields/poor-markup",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "GET /fields/dynamic": () =>
    page({
      id: "fields-dynamic",
      title: "Conditional and dynamic controls",
      body: `<p>Controls appear, disappear and are inserted after load. An observation taken before
a change must not be reused afterwards.</p>
<form method="post" action="/fields/dynamic" enctype="multipart/form-data" novalidate>
${selectField({
  name: "employment_type",
  label: "Employment type",
  options: [
    { value: "", label: "Select" },
    { value: "full_time", label: "Full time" },
    { value: "contract", label: "Contract" },
  ],
})}
<div id="conditional"></div>
<div id="late-controls"></div>
<button type="submit">Save</button>
</form>
<script>
(function () {
  var select = document.getElementById('f-employment_type');
  var slot = document.getElementById('conditional');
  select.addEventListener('change', function () {
    if (select.value === 'contract') {
      slot.innerHTML =
        '<label for="f-day_rate">Day rate</label>' +
        '<input id="f-day_rate" name="day_rate" type="number" required>' +
        '<label for="f-agency">Agency name</label><input id="f-agency" name="agency">';
    } else if (select.value === 'full_time') {
      slot.innerHTML =
        '<label for="f-salary">Expected salary</label>' +
        '<input id="f-salary" name="salary" type="number" required>';
    } else {
      slot.innerHTML = '';
    }
  });
  setTimeout(function () {
    document.getElementById('late-controls').innerHTML =
      '<label for="f-late_field">Inserted after load</label>' +
      '<input id="f-late_field" name="late_field" value="">';
    document.body.setAttribute('data-fixture-late-controls', 'ready');
  }, 300);
})();
</script>`,
    }),

  "POST /fields/dynamic": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/fields/dynamic",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "GET /fields/shadow": () =>
    page({
      id: "fields-shadow",
      title: "Shadow DOM",
      body: `<p>The form below lives inside an open shadow root, nested one level deep.</p>
<mu-outer-host></mu-outer-host>
<div id="shadow-status" data-shadow-value=""></div>
<script>
class MuInnerHost extends HTMLElement {
  connectedCallback() {
    var root = this.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<label for="s-inner">Shadow input</label>' +
      '<input id="s-inner" name="shadow_input">' +
      '<button type="button" id="s-apply">Apply shadow value</button>';
    root.getElementById('s-apply').addEventListener('click', function () {
      document.getElementById('shadow-status').setAttribute(
        'data-shadow-value', root.getElementById('s-inner').value);
    });
  }
}
class MuOuterHost extends HTMLElement {
  connectedCallback() {
    var root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<p>Outer shadow root</p><mu-inner-host></mu-inner-host>';
  }
}
customElements.define('mu-inner-host', MuInnerHost);
customElements.define('mu-outer-host', MuOuterHost);
</script>`,
    }),

  "GET /fields/validation": () =>
    page({
      id: "fields-validation",
      title: "Client and server validation",
      body: `<p>The browser blocks an empty required field; the server rejects a value the browser
considers acceptable.</p>
<form method="post" action="/fields/validation" enctype="multipart/form-data">
${textField({ name: "account_id", label: "Account id", required: true, placeholder: "8 digits" })}
${textField({ name: "confirm_email", label: "Confirm email", type: "email", required: true })}
<button type="submit">Check</button>
</form>`,
    }),

  "POST /fields/validation": async (ctx) => {
    const form = await parseForm(ctx.req);
    const accountId = form.values.account_id?.[0] ?? "";
    if (!/^\d{8}$/.test(accountId)) {
      return page({
        id: "fields-validation",
        title: "Client and server validation",
        status: 422,
        body: `<div class="errors" role="alert" data-fixture-errors="1">
<p>Account id must be exactly 8 digits. You sent ${esc(accountId || "nothing")}.</p></div>
<form method="post" action="/fields/validation" enctype="multipart/form-data">
${textField({ name: "account_id", label: "Account id", required: true, value: accountId })}
${textField({ name: "confirm_email", label: "Confirm email", type: "email", required: true, value: form.values.confirm_email?.[0] ?? "" })}
<button type="submit">Check</button>
</form>`,
      });
    }
    return finishSubmission(ctx, {
      path: "/fields/validation",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },
};
