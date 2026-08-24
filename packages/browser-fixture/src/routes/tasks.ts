import { parseForm } from "../form.ts";
import { page, textField } from "../html.ts";
import type { RouteTable } from "../router.ts";
import { finishSubmission } from "./outcomes.ts";

const RESEARCH_ROWS = `<table>
<caption>Support plans</caption>
<thead><tr><th>Provider</th><th>Monthly price</th><th>Response time</th><th>Regions</th></tr></thead>
<tbody>
<tr><th>Atlas</th><td>USD 12</td><td>4 hours</td><td>US, EU</td></tr>
<tr><th>Beacon</th><td>USD 18</td><td>1 hour</td><td>US, EU, APAC</td></tr>
</tbody>
</table>`;

export const taskRoutes: RouteTable = {
  "GET /tasks/research": () =>
    page({
      id: "task-research",
      title: "Research comparison",
      body: `<p>Compare the two published support plans. Prices are synthetic fixture data.</p>
${RESEARCH_ROWS}
<p><a href="/tasks/research/atlas" target="_blank" rel="noopener">Atlas details</a></p>
<p><a href="/tasks/research/beacon" target="_blank" rel="noopener">Beacon details</a></p>`,
    }),

  "GET /tasks/research/atlas": () =>
    page({
      id: "task-research-atlas",
      title: "Atlas plan",
      body: "<h1>Atlas</h1><p>USD 12 monthly. Four-hour response. US and EU coverage.</p>",
    }),

  "GET /tasks/research/beacon": () =>
    page({
      id: "task-research-beacon",
      title: "Beacon plan",
      body: "<h1>Beacon</h1><p>USD 18 monthly. One-hour response. US, EU and APAC coverage.</p>",
    }),

  "GET /tasks/schedule": () =>
    page({
      id: "task-schedule",
      title: "Schedule an interview",
      body: `<p>Choose a synthetic interview slot.</p>
<form method="post" action="/tasks/schedule" enctype="multipart/form-data">
${textField({ name: "interview_date", label: "Interview date", type: "date", required: true })}
<label for="time-slot">Time slot</label>
<select id="time-slot" name="time_slot" required>
<option value="">Select a time</option>
<option value="09:00Z">09:00 UTC</option>
<option value="14:00Z">14:00 UTC</option>
</select>
${textField({ name: "note", label: "Note" })}
<button type="submit">Book interview</button>
</form>`,
    }),

  "POST /tasks/schedule": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/tasks/schedule",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },

  "GET /tasks/account": () =>
    page({
      id: "task-account",
      title: "Account settings",
      body: `<p>Change preferences for a synthetic fixture account.</p>
<form method="post" action="/tasks/account" enctype="multipart/form-data">
<label for="time-zone">Time zone</label>
<select id="time-zone" name="time_zone">
<option value="UTC">UTC</option>
<option value="America/New_York">America/New_York</option>
<option value="Asia/Kolkata">Asia/Kolkata</option>
</select>
<label><input type="checkbox" name="weekly_digest" value="yes"> Weekly digest</label>
<button type="submit">Update account</button>
</form>`,
    }),

  "POST /tasks/account": async (ctx) => {
    const form = await parseForm(ctx.req);
    return finishSubmission(ctx, {
      path: "/tasks/account",
      fields: form.fields,
      files: form.files,
      outcome: "confirmed",
    });
  },
};
