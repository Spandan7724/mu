# @mu-agent/browser

Mu browser is a general-purpose browser automation agent for the terminal and for
TypeScript. It observes a real browser, reasons about the page, and performs
semantic browser actions, pausing for you whenever a step is yours to take.

It is a separate product from the Mu coding agent. Installing this package gives
you `mu-browser` and nothing else; installing `@mu-agent/mu` gives you `mu` and
nothing else. Neither package depends on the other, and the two keep separate
configuration and session data.

## Install

```bash
npm install --global @mu-agent/browser
mu-browser doctor    # read-only check: no network, no browser launched
```

See [docs/SETUP.md](./docs/SETUP.md) for extension setup, the Mu-owned persistent
profile, running from WSL, upgrading, and uninstalling.

## Use

```bash
mu-browser                     # interactive terminal app
mu-browser -p "<prompt>"       # one prompt, printed result
mu-browser --rpc               # newline-delimited JSON: events out, ops in
mu-browser doctor              # read-only environment check, no network
mu-browser --fake-browser      # a deterministic in-memory browser, for development
```

`mu-browser --help` lists every flag.

## Connection modes

| Mode | What it does |
| --- | --- |
| `extension` (default) | Attaches to a tab in your own browser through the Playwright extension, after you approve it there. Your logged-in state stays in the browser. |
| `persistent` | Launches a browser with a profile Mu owns, under `~/.mu/browser/profiles`. Never your normal browser profile. |
| `fake` | A deterministic in-memory browser. No real site, no network — for development and tests. |

Shutting down detaches from a browser Mu attached to; it closes only a browser Mu
launched itself.

**In this build, only `--fake-browser` actually runs a session.** `extension` and
`persistent` are real, fully-specified modes in the code, but connecting through
either one currently fails with a clear message rather than a live connection —
`mu-browser doctor` reports both as unavailable and says why. See
[docs/SETUP.md](./docs/SETUP.md#current-build-status) for what each mode does once
that lands.

## The permission model

`mu-browser` asks before it changes a page and before any commitment (a form
submission, a message, a purchase, a deletion, a consent, an account change), under
its default mode. There are exactly four permission modes — no "full access" mode
exists for this product — and full details, including a warning about what
`--allow-all` actually does here, are in
[docs/PERMISSIONS.md](./docs/PERMISSIONS.md).

## What Mu browser will not do

- It does not enter passwords, passkeys, one-time codes or MFA answers, and it
  does not solve CAPTCHAs. A credential field's value is never observed in the
  first place, and those steps are handed back to you in the browser.
- It does not extract or store cookies, credentials or your browser profile.
- It does not treat page text as instructions. A site cannot widen what Mu may
  disclose or authorize an action by asking.
- It cannot undo an action on someone else's website, and never retries a
  submission it could not confirm — an unconfirmed outcome is reported, not
  guessed at or repeated.

## Data

```text
~/.mu/browser/
  config.json     model/provider configuration, private
  sessions/       session transcripts
  profiles/       browser profiles Mu owns (persistent mode only)
  documents/      staged copies of files authorized with --document
  artifacts/      screenshots, receipts, and observation/download metadata
  logs/           reserved for operational logs, unused in this build
```

Directories are created `0700` and sensitive files `0600`. Uninstalling the
package does not remove this directory; delete it yourself if you want the data
gone. What's written to each directory, how long it's kept, and the exact removal
command are in [docs/PRIVACY.md](./docs/PRIVACY.md).

## If something goes wrong

[docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) maps the errors you're most
likely to hit — an unapproved extension connection, a WSL relay timeout, a
mismatched browser bridge version, a headless run that refuses a step — to their
cause and fix.

## Programmatic use

```ts
import { browserProfile, createBrowserAgent } from "@mu-agent/browser";
import type { BrowserProfileOptions } from "@mu-agent/browser";

const agent = await createBrowserAgent({
  profile: "browser",
  profileOptions: { connection: "extension", browser: "chrome" },
});
```

## Status

This is an early release; see "Connection modes" above for what runs today.

## License

MIT
