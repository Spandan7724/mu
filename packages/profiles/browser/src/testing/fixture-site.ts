import { readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_DIR = join(import.meta.dir, "..", "..", "test", "fixtures", "site");

export interface FixtureSite {
  origin: string;
  // A different host name, so its pages are cross-site (out-of-process) inside `origin` pages.
  crossOrigin: string;
  url: (page: string) => string;
  // What the wizard fixture's final submit sent, oldest first.
  submissions: Record<string, unknown>[];
  // Sign-ups on the signup fixture: the code it "emailed" and whether it was entered.
  signups: { email: string; code: string; verified: boolean }[];
  stop: () => void;
}

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function startFixtureSite(): FixtureSite {
  let origin = "";
  let crossOrigin = "";
  const submissions: Record<string, unknown>[] = [];
  const signups: FixtureSite["signups"] = [];
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/signup/send" && request.method === "POST") {
      const { email } = (await request.json()) as { email: string };
      const code = String(100_000 + Math.floor(Math.random() * 900_000));
      signups.push({ email, code, verified: false });
      return Response.json({ sent: true });
    }
    if (path === "/signup/verify" && request.method === "POST") {
      const { code } = (await request.json()) as { code: string };
      const signup = signups.at(-1);
      const ok = !!signup && signup.code === code.trim();
      if (ok && signup) signup.verified = true;
      return Response.json({ ok });
    }
    if (path === "/mail/messages") {
      // The inbox shows the codes the signup page sent, newest first, among unrelated mail.
      return Response.json([
        ...signups
          .map((signup) => ({
            from: "Example Corp <no-reply@example.test>",
            subject: "Your Example Corp verification code",
            body: `Hi, your verification code is ${signup.code}. It expires in 10 minutes.`,
          }))
          .reverse(),
        {
          from: "Newsletter <news@shop.test>",
          subject: "Your code for 20% off: SAVE20NOW",
          body: "Use code 739104 at checkout.",
        },
      ]);
    }
    if (path === "/wizard/submit" && request.method === "POST") {
      submissions.push((await request.json()) as Record<string, unknown>);
      return Response.json({ reference: `WZ-${1000 + submissions.length}` });
    }
    if (path === "/api/suggest") {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const delay = Number(url.searchParams.get("delay") ?? 150);
      await Bun.sleep(delay);
      const all = ["Amsterdam", "Athens", "Austin", "Berlin", "Boston", "Barcelona", "Paris"];
      return Response.json(all.filter((city) => city.toLowerCase().startsWith(query)));
    }
    if (path === "/api/slow") {
      await Bun.sleep(Number(url.searchParams.get("ms") ?? 500));
      return Response.json({ ok: true });
    }
    if (path === "/echo" && request.method === "POST") {
      const form = await request.formData();
      const rows = [...form.entries()]
        .map(([key, value]) => `<tr><th>${key}</th><td>${String(value)}</td></tr>`)
        .join("");
      return html(`<title>Submitted</title><h1>Submitted</h1><table>${rows}</table>`);
    }
    if (path === "/download/report.csv") {
      return new Response("name,value\nalpha,1\n", {
        headers: {
          "content-type": "text/csv",
          "content-disposition": 'attachment; filename="report.csv"',
        },
      });
    }
    const name = path === "/" ? "index" : path.slice(1).replace(/\.html$/, "");
    if (!/^[a-z0-9-]+$/.test(name)) return new Response("not found", { status: 404 });
    try {
      const source = readFileSync(join(FIXTURE_DIR, `${name}.html`), "utf8");
      return html(
        source.replaceAll("{{ORIGIN}}", origin).replaceAll("{{CROSS_ORIGIN}}", crossOrigin),
      );
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
  const main = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  const cross = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  origin = `http://127.0.0.1:${main.port}`;
  crossOrigin = `http://localhost:${cross.port}`;
  return {
    origin,
    crossOrigin,
    url: (page) => `${origin}/${page}`,
    submissions,
    signups,
    stop: () => {
      main.stop(true);
      cross.stop(true);
    },
  };
}
