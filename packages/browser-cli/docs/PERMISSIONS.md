# The permission model

`mu-browser` ships exactly four permission modes. There is deliberately no "full
access" mode — one existed earlier in development and was removed for weakening the
security model — so the list below is the complete set, not a summary of it. Pick one
with `--permission-mode <id>`, or switch during an interactive session the way you
switch modes in the coding product.

| Mode | Default? | What it does |
| --- | --- | --- |
| `confirm-submission` | yes | Browse, navigate, and fill freely; asks before anything that submits, sends, purchases, deletes, consents, or changes an account. |
| `confirm-every-write` | | Asks before every change to a page — every fill, click, and upload — not only before commitments. |
| `read-only` | | Observe and navigate only; every interaction, upload, and commitment is refused outright, not just asked about. |
| `autonomous-submit` | | Fills and **submits forms or sends messages** without asking, on any origin the task has already reached — which itself still requires approval the first time (see "Origins" below). Purchases, deletions, consent, and account changes still ask, always. |

A few things hold regardless of mode:

- **Disclosing an authorized personal fact into a field always asks**, in every mode
  including `autonomous-submit` and `confirm-submission`. No mode pre-authorizes that
  scope; only the write itself (filling a field with a literal value) is subject to
  the table above.
- **Purchases, deletions, consent, and account changes are never pre-authorized by any
  mode.** `autonomous-submit` pre-authorizes exactly two intents — ordinary form
  submission and sending a message — nothing else.
- **A page's text is never authority.** Instructions embedded in a page ("ignore your
  previous instructions and…") do not widen what a mode allows; page content is
  wrapped as untrusted observation before the model ever sees it.
- **Login, password, passkey, MFA, and CAPTCHA fields are a hard stop**, independent
  of permission mode: the field's value is never observed in the first place (not
  just redacted afterward), and the tool routes to `browser_takeover` so you finish
  that step in the real browser.
- **A generic action can never perform a commitment.** `browser_act` refuses a click
  on what it recognizes as a submit/send/purchase/delete/consent/account-change
  control and tells the model to use `browser_submit` instead, which is the only path
  a commitment can take and is where the table above actually applies.
- **A stale reference is rejected, never guessed at.** An element reference from
  before a navigation or a page change does not resolve to whatever now occupies that
  slot; the tool must re-observe.

## `--allow-all`

`--allow-all` (and its cousin `--permission-mode yolo`, which the coding product
recognizes) is a flag shared across every Mu product, not something the browser
profile customizes. On `mu-browser` it does exactly what it says: it installs a
blanket "allow everything" rule that overrides every mode's asks, **including
purchases, deletions, consent, and account changes**. It does not add a `yolo` mode to
this product's four — there is no such mode here — but the flag bypasses the
permission engine regardless of which modes a profile defines.

What it does *not* bypass: page-observed credential fields are still never captured
(that happens before permission checks run at all), and `browser_takeover` for
login/MFA/CAPTCHA still triggers. But every ask-level prompt this document describes
above, including for an irreversible commitment, is silenced. Avoid `--allow-all` on
this product; use `--permission-mode autonomous-submit` if you want form-fill-and-
submit without per-step prompts; it keeps the commitment categories that matter most
un-bypassable.

## Origins

By default a task may act only on the origin(s) implied by what you asked it to do.
Reaching a different origin — including a cross-origin `<iframe>`, which is decided on
its own origin rather than inheriting the top-level page's approval — asks, showing
the exact origin (never collapsed to a brand name, so a lookalike domain is visible as
what it is). Pass `--allow-origin <origin>` (repeatable) to pre-approve additional
origins for the task; there is no wildcard and no way for a page itself to add to this
list.

## Documents

`--document <path>` (repeatable) authorizes one local file for the agent to reference
or upload. Only an authorized document's logical id is ever visible to the model —
never a filesystem path. Uploading it follows the same write permission as any other
change to a page: it asks under `confirm-submission` and `confirm-every-write`, is
refused outright under `read-only`, and is allowed without asking under
`autonomous-submit`. See [PRIVACY.md](./PRIVACY.md) for where the file goes on disk.
