# The permission model

`mu-browser` ships five permission modes. Pick one with `--permission-mode <id>`, or
switch during an interactive session the way you switch modes in the coding product.

| Mode | Default? | What it does |
| --- | --- | --- |
| `confirm-submission` | yes | Browse, navigate, and fill freely; asks before anything that submits, sends, purchases, deletes, consents, or changes an account. |
| `confirm-every-write` | | Asks before every change to a page — every fill, click, and upload — not only before commitments. |
| `read-only` | | Observe and navigate only; every interaction, upload, and commitment is refused outright, not just asked about. |
| `autonomous-submit` | | Fills and **submits forms or sends messages** without asking, on any origin the task has already reached — which itself still requires approval the first time (see "Origins" below). Purchases, deletions, consent, and account changes still ask, always. |
| `yolo` | | **Full access.** Allows every Mu permission scope without asking, including new origins, disclosures, uploads, purchases, deletions, consent, account changes, unknown-risk controls, and page-dialog acceptance. |

A few structural safety and correctness rules hold regardless of mode:

- `confirm-submission` and `autonomous-submit` still ask before disclosing an authorized
  personal fact; `yolo` does not.
- `autonomous-submit` pre-authorizes exactly ordinary form submission and sending;
  `yolo` also pre-authorizes purchases, deletions, consent, and account changes.
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

`--allow-all` is an alias for `--permission-mode yolo`:

```
$ mu-browser --allow-all
```

This is the explicit, unrestricted mode. It suppresses every permission prompt for the
session, including prompts for consequential external actions. Use
`--permission-mode autonomous-submit` instead when only form submission and sending
should be autonomous.

Full access changes permission decisions only. It does not make unsafe URL schemes
valid, retarget stale references, let generic clicks bypass `browser_submit`, expose
passwords or MFA values, invent missing personal facts, retry uncertain commitments, or
turn an unconfirmed external effect into a success. Those are tool and policy invariants,
not permission asks.

## Origins

By default a task may act only on the origin(s) implied by what you asked it to do. An
explicit `http://` or `https://` URL in your own task message authorizes that URL's
origin for the task. URLs found in page text, tool output, or other untrusted content do
not.

Reaching a different origin — including a cross-origin `<iframe>`, which is decided on
its own origin rather than inheriting the top-level page's approval — asks in every mode
except `yolo`, showing the exact origin (never collapsed to a brand name, so a lookalike
domain is visible as what it is). Pass `--allow-origin <origin>` (repeatable) to
pre-approve additional origins for the task. A page itself cannot add to this list;
`yolo` authorizes the projected new-origin permission rather than mutating origin policy.

## Documents

Supported direct files in the directory where the session starts are available for
reference or upload. Subdirectories, hidden files, symlinks, unsupported types, and
paths outside that directory are excluded. Only a file's logical id and bounded
metadata are visible to the model—never a filesystem path. Uploading follows the same
write permission as any other page change: it asks under `confirm-submission` and
`confirm-every-write`, is refused under `read-only`, and is allowed without asking
under `autonomous-submit` and `yolo`. See [PRIVACY.md](./PRIVACY.md) for the private snapshot.
