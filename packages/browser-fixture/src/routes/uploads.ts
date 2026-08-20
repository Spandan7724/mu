import {
  OVERSIZED_UPLOAD_BYTES,
  POISONED_RESUME_BASENAME,
  POISONED_RESUME_PDF,
  SYNTHETIC_COVER_LETTER_BASENAME,
  SYNTHETIC_COVER_LETTER_PDF,
  SYNTHETIC_RESUME_BASENAME,
  SYNTHETIC_RESUME_PDF,
} from "../applicant.ts";
import { parseForm } from "../form.ts";
import { esc, fileField, page } from "../html.ts";
import type { FixtureContext, RouteTable } from "../router.ts";
import { finishSubmission } from "./outcomes.ts";

function attachment(bytes: Uint8Array, filename: string, mimeType: string): Response {
  return new Response(bytes, {
    headers: {
      "content-type": mimeType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${filename.replace(/["\\]/g, "_")}"`,
    },
  });
}

function rejection(ctx: FixtureContext, status: number, reason: string): Response {
  return page({
    id: "upload-rejected",
    title: "Upload rejected",
    status,
    body: `<div class="errors" role="alert" data-upload-rejected="${status}">
<p data-reject-reason>${esc(reason)}</p></div>
<p><a href="/uploads">Try another file</a></p>
<p>Limit: ${ctx.options.maxUploadBytes} bytes, accepted types
${esc(ctx.options.acceptedUploadMimeTypes.join(", "))}.</p>`,
  });
}

export const uploadRoutes: RouteTable = {
  "GET /uploads": (ctx) =>
    page({
      id: "uploads",
      title: "Uploads and downloads",
      body: `<p>The strict endpoint accepts ${esc(ctx.options.acceptedUploadMimeTypes.join(", "))}
up to ${ctx.options.maxUploadBytes} bytes and rejects everything else with a visible reason.</p>
<form method="post" action="/uploads/strict" enctype="multipart/form-data">
${fileField({ name: "document", label: "Document", accept: "application/pdf", required: true })}
<button type="submit">Upload</button>
</form>
<h2>Multiple files</h2>
<form method="post" action="/uploads/multiple" enctype="multipart/form-data">
${fileField({ name: "documents", label: "Documents", multiple: true })}
<button type="submit">Upload all</button>
</form>
<h2>Progress</h2>
<form id="progress-form">
${fileField({ name: "document", label: "Document (XHR upload with progress)" })}
<button type="button" id="start-upload">Upload with progress</button>
</form>
<progress id="upload-progress" value="0" max="100"></progress>
<p id="upload-status" data-upload-status="idle"></p>
<h2>Downloads</h2>
<ul>
<li><a href="/download/resume" id="dl-resume">${esc(SYNTHETIC_RESUME_BASENAME)}</a></li>
<li><a href="/download/cover-letter" id="dl-cover">${esc(SYNTHETIC_COVER_LETTER_BASENAME)}</a></li>
<li><a href="/download/poisoned" id="dl-poisoned">Offer letter (filename carries instructions)</a></li>
<li><a href="/download/oversized" id="dl-oversized">Large file (${OVERSIZED_UPLOAD_BYTES} bytes)</a></li>
</ul>
<script>
(function () {
  var btn = document.getElementById('start-upload');
  btn.addEventListener('click', function () {
    var input = document.querySelector('#progress-form input[type=file]');
    if (!input.files.length) return;
    var status = document.getElementById('upload-status');
    var bar = document.getElementById('upload-progress');
    var body = new FormData();
    body.append('document', input.files[0]);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/uploads/slow');
    xhr.upload.addEventListener('progress', function (e) {
      if (e.lengthComputable) bar.value = Math.round((e.loaded / e.total) * 100);
      status.setAttribute('data-upload-status', 'uploading');
    });
    xhr.addEventListener('load', function () {
      bar.value = 100;
      status.setAttribute('data-upload-status', xhr.status === 200 ? 'done' : 'error');
      status.textContent = 'HTTP ' + xhr.status;
    });
    xhr.send(body);
  });
})();
</script>`,
    }),

  "POST /uploads/strict": async (ctx) => {
    const form = await parseForm(ctx.req);
    const file = form.files.find((f) => f.field === "document");
    if (!file) return rejection(ctx, 400, "No file was attached.");
    if (!ctx.options.acceptedUploadMimeTypes.includes(file.mimeType)) {
      return rejection(ctx, 415, `Unsupported media type: ${file.mimeType}.`);
    }
    if (file.bytes > ctx.options.maxUploadBytes) {
      return rejection(
        ctx,
        413,
        `File is ${file.bytes} bytes; the limit is ${ctx.options.maxUploadBytes}.`,
      );
    }
    return finishSubmission(ctx, {
      path: "/uploads/strict",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "POST /uploads/multiple": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/uploads/multiple",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "POST /uploads/slow": async (ctx) => {
    const form = await parseForm(ctx.req);
    await Bun.sleep(200);
    return finishSubmission(ctx, {
      path: "/uploads/slow",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "GET /download/resume": () =>
    attachment(SYNTHETIC_RESUME_PDF, SYNTHETIC_RESUME_BASENAME, "application/pdf"),
  "GET /download/cover-letter": () =>
    attachment(SYNTHETIC_COVER_LETTER_PDF, SYNTHETIC_COVER_LETTER_BASENAME, "application/pdf"),
  "GET /download/poisoned": () =>
    attachment(POISONED_RESUME_PDF, POISONED_RESUME_BASENAME, "application/pdf"),
  "GET /download/oversized": () =>
    attachment(
      new Uint8Array(OVERSIZED_UPLOAD_BYTES),
      "large-attachment.bin",
      "application/octet-stream",
    ),
};
