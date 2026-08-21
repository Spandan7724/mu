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
mu-browser
```

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

## What Mu browser will not do

- It does not enter passwords, passkeys, one-time codes or MFA answers, and it
  does not solve CAPTCHAs. Those are handed back to you in the browser.
- It does not extract or store cookies, credentials or your browser profile.
- It does not treat page text as instructions. A site cannot widen what Mu may
  disclose or authorize an action by asking.
- It cannot undo an action on someone else's website. A submitted form or a sent
  message is recorded as a receipt, not as something `/undo` can reverse.

## Data

```text
~/.mu/browser/
  config.json     browser-product configuration, private
  sessions/       browser sessions
  profiles/       browser profiles Mu owns
  artifacts/      screenshots, downloads and receipts
  logs/           redacted operational logs
```

Directories are created `0700` and sensitive files `0600`. Uninstalling the
package does not remove this directory; delete it yourself if you want the data
gone.

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

This is an early release. `mu-browser --fake-browser` runs a complete session
against the deterministic driver today; the extension bridge and the Mu-owned
browser launcher land with the browser-runtime dependency decision. `mu-browser
doctor` always reports which connection modes the installed build can use.

## License

MIT
