# Privacy, data, and removal

Everything `mu-browser` writes lives under `~/.mu/browser/`, as a sibling of (never
inside) the coding product's `~/.mu` state. Every directory is created `0700` and every
sensitive file `0600` (Windows has no equivalent bits; the calls are made anyway and
simply have no effect there).

```text
~/.mu/browser/
  config.json     model/provider configuration you set with /model or similar — 0600
  models.json     cached model catalog — 0600
  sessions/       session transcripts (conversation + tool calls), one per session
  profiles/       Mu-owned Chrome/Edge/Chromium profiles, only in persistent mode
  documents/      staged copies of files you authorized with --document
  artifacts/      screenshots, receipts, and download/observation metadata
  logs/           reserved for redacted operational logs
```

**In this build, `logs/` is created but not yet written to.** Session history,
`--document` staging, owned browser profiles and commitment receipts all work today; a
receipt is written under `artifacts/receipts/` every time a submission, send, purchase,
deletion, consent or account change actually happens, and the path is reported back in
the conversation. Screenshot capture and operational logging are fully specified and
unit-tested but not yet called by a shipped code path.

## What never reaches disk, a log, or the model at all

- **Passwords, passkeys, one-time codes, and other credential-field values.** The
  observation layer strips them before they are ever assembled into what the model
  sees (`isCredentialElement`, BD14) — not redacted after the fact, never captured.
  Password entry, MFA, and CAPTCHAs are handed back to you in the real browser
  (`browser_takeover`); Mu is not in that loop.
- **Cookies, session storage, and your browser's login state.** Mu never calls a
  cookie or storage export API. In `extension` mode your login state stays in your
  browser and Mu only ever sees what the page's accessibility tree exposes. In
  `persistent` mode the Mu-owned profile may accumulate cookies from sites you visit
  through it, but Mu does not parse, read, or back them up — the browser owns them
  the same way it would for a profile you drove by hand.
- **Bearer tokens, API keys, `Authorization`/`Set-Cookie` headers, and full payment
  card numbers**, wherever they might otherwise show up in a receipt, a disclosure
  record, or a tool result — a pattern-based scrubber (`artifacts/redaction.ts`)
  removes them before a receipt is written, and a receipt that still contains a
  scrubbed value fails to build rather than being written anyway.

## What does reach disk, and where

**`sessions/`** — the full conversation and tool-call history for a session, the same
mechanism the coding product uses. This includes page text Mu read while observing,
and values it typed into fields on your behalf — including a `personal`-sensitivity
fact you authorized (name, email, phone), in plain text. A fact marked `sensitive`
(address, compensation, demographics, …) is replaced with `[redacted]` in tool output
before it is recorded, so it does not appear here either. There is no separate
retention bound on this directory today; it grows with your usage the way a chat log
would, and removing it is a plain `rm`.

**`documents/`** — when you pass `--document <path>`, Mu copies that exact file into
`documents/<id>/<basename>` (`0600` inside a `0700` parent) and authorizes the copy,
not the original. Your original file is never modified or moved. Copying is required
because the browser bridge refuses to attach a path outside the roots it was started
with, and the alternative — letting Mu's browser tools reach arbitrary paths on your
filesystem — would also make `file://` navigation reachable from the page, which is a
line the product does not cross. A staged copy is re-hashed against the byte-for-byte
original at the moment it is used; if the source changed since authorization, Mu
refuses to use the stale copy. Limits: 25 MB per file, 100 authorized documents per
session.

**`artifacts/`** — receipts (written today, under `receipts/`), plus the designed home
for screenshots and metadata about observations and downloads, each pruned on its own
bound (below). When a download does occur today, only metadata about it (name,
size, MIME type) is surfaced in the conversation — the file's bytes are never read
back to the model — but that metadata is not yet also written to
`artifacts/downloads/`. The sidecar's own scratch output is pinned inside this root
rather than the directory you started `mu-browser` from.

**`profiles/`** — only populated in `persistent` connection mode: a
Chrome/Edge/Chromium user-data directory Mu owns outright, under its own
name (`profiles/<name>/`, `default` unless you pass `--browser-profile`) — never a
path into your own browser's profile directory. An `owner.json` lock file records
which running `mu-browser` process currently holds it, so two sessions cannot drive
the same profile at once.

## Receipts: the accountability record, once wired

The receipt format is fully specified and validated today, and the `/receipt`
command already reads from `artifacts/receipts/` — but in this build nothing calls
the code that writes one after a commitment, so `/receipt` will currently tell you
there are none. Once writing is wired, a `browser_submit` action that actually
reached the site (a form submission, a message send, a purchase, a deletion, a
consent, an account change) will produce a receipt in
`artifacts/receipts/<id>.json`: the origin, the intent, a status (`confirmed` /
`unconfirmed` / `unknown` / `failed`), which field *names* were disclosed and which
authorized fact ids they came from (never the values), which authorized document ids
were uploaded (id, filename, sha256 — never the file), and a reference to a
screenshot path if one was taken. A receipt is built to never inline a screenshot or
any other artifact's bytes — only a path within `artifacts/` — and a receipt that
still contained a value that must stay redacted would fail to build rather than be
written with it inside.

## Retention bounds

These bounds exist in the code today and will apply as soon as each artifact kind
starts being written (see the note above — none of them are populated yet in this
build). Each kind is capped independently, in count, total bytes, and age. Mu prunes
on every write; the newest artifact of a kind is exempt from the count/size eviction
(never age) so a write you just made is never immediately deleted out from under you.

| Kind | Max count | Max total size | Max age |
| --- | --- | --- | --- |
| Screenshot | 20 | 20 MB | 7 days |
| Observation metadata | 50 | 10 MB | 7 days |
| Download metadata | 100 | 2 MB | 7 days |
| Receipt | 500 | 25 MB | 180 days |
| Operational log | 10 | 20 MB | 14 days |

`sessions/`, `documents/`, and `profiles/` have no automatic eviction — they persist
until you remove them.

## Removing your data

Uninstalling the npm package does not touch `~/.mu/browser/` — that is deliberate, the
same way removing a program does not delete the files it saved. To remove everything
`mu-browser` has ever written:

```bash
rm -rf ~/.mu/browser
```

To remove only one category, delete the matching subdirectory instead (e.g.
`rm -rf ~/.mu/browser/sessions` to drop transcripts but keep a persistent Chrome
profile and its cookies). There is no in-product command that does this for you —
`mu-browser` ships no `self uninstall` or `/purge` (that is a coding-product-only
command); removal is a filesystem operation you run yourself.
