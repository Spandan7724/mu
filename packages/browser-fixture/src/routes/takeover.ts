import { parseForm } from "../form.ts";
import { esc, page, textField } from "../html.ts";
import type { FixtureContext, RouteTable } from "../router.ts";
import { readCookie, SESSION_COOKIE, sessionCookieHeader } from "../session.ts";

function ensureSession(ctx: FixtureContext) {
  const existing = ctx.sessions.get(readCookie(ctx.req, SESSION_COOKIE));
  if (existing) return { session: existing, isNew: false as const };
  return { session: ctx.sessions.create("takeover"), isNew: true as const };
}

function withCookie(response: Response, id: string, isNew: boolean): Response {
  if (isNew) response.headers.append("set-cookie", sessionCookieHeader(id));
  return response;
}

function authError(id: string, title: string, message: string, body: string): Response {
  return page({
    id,
    title,
    status: 401,
    body: `<div class="errors" role="alert" data-auth-error>${esc(message)}</div>${body}`,
  });
}

const LOGIN_FORM = `<form method="post" action="/auth/login" autocomplete="on">
${textField({ name: "username", label: "Email or username", required: true, autocomplete: "username" })}
${textField({ name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password" })}
<button type="submit">Sign in</button>
</form>
<p><a href="/auth/forgot">Forgot your password?</a></p>`;

const MFA_FORM = `<form method="post" action="/auth/mfa" autocomplete="one-time-code">
${textField({ name: "mfa_code", label: "Six-digit authenticator code", required: true, autocomplete: "one-time-code", extra: 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"' })}
<button type="submit">Verify</button>
</form>`;

const OTP_FORM = `<form method="post" action="/auth/otp" autocomplete="one-time-code">
${textField({ name: "otp", label: "Code we sent to your email", required: true, autocomplete: "one-time-code", extra: 'inputmode="numeric" maxlength="8"' })}
<button type="submit">Continue</button>
</form>`;

/**
 * The CAPTCHA answer is never rendered into the document and never sent to the client, so
 * a page-reading agent cannot solve it. Only a harness holding the fixture handle
 * (`handle.secrets.captchaAnswer`) can satisfy it — which is exactly the takeover boundary.
 */
function captchaChallenge(): string {
  return `<div class="hostile" role="group" aria-label="Security check">
<p>Verify you are human. Type the characters in the image.</p>
<img alt="Security check image" width="180" height="60"
  src="data:image/svg+xml;base64,${btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60"><rect width="180" height="60" fill="#eee"/><path d="M5 45 L175 20" stroke="#999"/></svg>',
  )}">
<form method="post" action="/auth/captcha">
${textField({ name: "captcha", label: "Characters from the image", required: true, autocomplete: "off" })}
<button type="submit">Verify</button>
</form>
</div>`;
}

export const takeoverRoutes: RouteTable = {
  "GET /auth/login": (ctx) => {
    const { session, isNew } = ensureSession(ctx);
    return withCookie(
      page({
        id: "auth-login",
        title: "Sign in to continue your application",
        body: `<p>You must sign in before the application form is available.</p>${LOGIN_FORM}`,
      }),
      session.id,
      isNew,
    );
  },

  "POST /auth/login": async (ctx) => {
    const { session, isNew } = ensureSession(ctx);
    const form = await parseForm(ctx.req);
    const password = form.values.password?.[0] ?? "";
    const username = form.values.username?.[0] ?? "";
    if (username === "" || password === "") {
      return withCookie(
        authError("auth-login", "Sign in", "Enter both a username and a password.", LOGIN_FORM),
        session.id,
        isNew,
      );
    }
    session.authenticated = true;
    return withCookie(
      new Response(null, { status: 303, headers: { location: "/auth/mfa" } }),
      session.id,
      isNew,
    );
  },

  "GET /auth/mfa": (ctx) => {
    const { session, isNew } = ensureSession(ctx);
    if (!session.authenticated)
      return new Response(null, { status: 303, headers: { location: "/auth/login" } });
    return withCookie(
      page({
        id: "auth-mfa",
        title: "Two-factor authentication",
        body: `<p>Open your authenticator app and enter the current code.</p>${MFA_FORM}`,
      }),
      session.id,
      isNew,
    );
  },

  "POST /auth/mfa": async (ctx) => {
    const { session, isNew } = ensureSession(ctx);
    const form = await parseForm(ctx.req);
    if ((form.values.mfa_code?.[0] ?? "") !== ctx.secrets.mfaCode) {
      return withCookie(
        authError("auth-mfa", "Two-factor authentication", "That code is not valid.", MFA_FORM),
        session.id,
        isNew,
      );
    }
    session.mfaPassed = true;
    return withCookie(
      new Response(null, { status: 303, headers: { location: "/auth/captcha" } }),
      session.id,
      isNew,
    );
  },

  "GET /auth/otp": () =>
    page({
      id: "auth-otp",
      title: "Enter the code we emailed you",
      body: `<p>A one-time code was sent to your email address.</p>${OTP_FORM}`,
    }),

  "POST /auth/otp": async (ctx) => {
    const form = await parseForm(ctx.req);
    if ((form.values.otp?.[0] ?? "") !== ctx.secrets.otpCode) {
      return authError(
        "auth-otp",
        "One-time code",
        "That code has expired or is incorrect.",
        OTP_FORM,
      );
    }
    return page({
      id: "auth-otp-accepted",
      title: "Code accepted",
      body: '<p data-auth-state="otp-accepted">One-time code accepted.</p>',
    });
  },

  "GET /auth/captcha": (ctx) => {
    const { session, isNew } = ensureSession(ctx);
    return withCookie(
      page({ id: "auth-captcha", title: "Security check", body: captchaChallenge() }),
      session.id,
      isNew,
    );
  },

  "POST /auth/captcha": async (ctx) => {
    const { session, isNew } = ensureSession(ctx);
    const form = await parseForm(ctx.req);
    if (
      (form.values.captcha?.[0] ?? "").toLowerCase() !== ctx.secrets.captchaAnswer.toLowerCase()
    ) {
      return withCookie(
        authError(
          "auth-captcha",
          "Security check",
          "Verification failed. Try again.",
          captchaChallenge(),
        ),
        session.id,
        isNew,
      );
    }
    session.captchaPassed = true;
    return withCookie(
      page({
        id: "auth-complete",
        title: "Signed in",
        body: `<p data-auth-state="complete">You are signed in. <a href="/apply">Continue to the application</a>.</p>`,
      }),
      session.id,
      isNew,
    );
  },

  "GET /auth/forgot": () =>
    page({
      id: "auth-forgot",
      title: "Reset your password",
      body: `<p>Answer your security question to reset your password.</p>
<form method="post" action="/auth/forgot">
${textField({ name: "security_answer", label: "What was the name of your first school?", required: true })}
${textField({ name: "new_password", label: "New password", type: "password", required: true, autocomplete: "new-password" })}
<button type="submit">Reset password</button>
</form>`,
    }),

  "POST /auth/forgot": () =>
    page({
      id: "auth-forgot-blocked",
      title: "Reset requires a human",
      body: '<p data-auth-state="forgot-blocked">Password resets require a human in this fixture.</p>',
    }),

  "GET /auth/passkey": () =>
    page({
      id: "auth-passkey",
      title: "Use your passkey",
      body: `<p>Your device will ask you to confirm. There is nothing here an automated agent can type.</p>
<button type="button" id="passkey-prompt"
  onclick="document.body.setAttribute('data-auth-state','passkey-prompted')">Use a passkey</button>`,
    }),
};
