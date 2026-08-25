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

See [docs/SETUP.md](./docs/SETUP.md) for Mu-owned profiles, browser selection,
running from WSL, upgrading, and uninstalling.

## Use

```bash
mu-browser                     # interactive terminal app
mu-browser -p "<prompt>"       # one prompt, printed result
mu-browser --rpc               # newline-delimited JSON: events out, ops in
mu-browser doctor              # read-only environment check, no network
mu-browser --fake-browser      # a deterministic in-memory browser, for development
```

`mu-browser --help` lists every flag.

The directory you launch `mu-browser` from is its local-file boundary. Supported
direct files there (PDF, office/text documents, and common images) are available for
upload by opaque id. Subdirectories, hidden files, symlinks, unsupported types, and
every path outside that directory are excluded. Run the command from the directory
that contains the files needed for the task.

## Browser profiles

| Choice | What it does |
| --- | --- |
| Default | Launches a browser with the persistent `default` profile Mu owns under `~/.mu/browser/profiles`. Never your normal browser profile. |
| `--browser-profile <name>` | Launches the same browser with another named persistent Mu profile. |
| `--fake-browser` | Uses a deterministic in-memory browser. No real site or network; for development and tests. |

Shutting down closes the browser process Mu launched. The profile remains on disk, so
cookies, history and login state are available next time that profile starts.

`mu-browser doctor` checks the sidecar and installed browser without launching one.

## The permission model

`mu-browser` asks before it changes a page and before any commitment (a form
submission, a message, a purchase, a deletion, a consent, an account change), under
its default mode. Five permission modes range from read-only through unrestricted
`yolo`; `--allow-all` selects unrestricted mode. Full details and the invariants that
full access does not bypass are in
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
  profiles/       persistent browser profiles Mu owns
  documents/      private snapshots of eligible launch-directory files
  artifacts/      screenshots, receipts, and observation/download metadata
  logs/           reserved for operational logs, unused in this build
```

Directories are created `0700` and sensitive files `0600`. Uninstalling the
package does not remove this directory; delete it yourself if you want the data
gone. What's written to each directory, how long it's kept, and the exact removal
command are in [docs/PRIVACY.md](./docs/PRIVACY.md).

## If something goes wrong

[docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) maps the errors you're most
likely to hit — a missing browser, a profile ownership conflict, a mismatched browser
bridge version, or a headless run that refuses a step — to their
cause and fix.

## Programmatic use

```ts
import { browserProfile, createBrowserAgent } from "@mu-agent/browser";
import type { BrowserProfileOptions } from "@mu-agent/browser";

const agent = await createBrowserAgent({
  profile: "browser",
  profileOptions: { browser: "chrome", userDataDir: "default" },
});
```

## Status

This is an early release; see "Browser profiles" above for what runs today.

## License

MIT
