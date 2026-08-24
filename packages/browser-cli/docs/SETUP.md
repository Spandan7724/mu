# Setup

## Install

```bash
npm install --global @mu-agent/browser
mu-browser doctor    # read-only check: no network call, no browser launched
```

`mu-browser doctor` reports the data root it will use and which connection modes the
installed build can reach. A mode it cannot reach is a note naming what to fix, not a
broken install.

## Local files

The directory where you start `mu-browser` is the session's local-file boundary. Put
documents you want it to upload directly in that directory, then start the session
there:

```bash
cd ~/job-application
mu-browser --connection persistent --browser chromium
```

Mu automatically admits up to 100 supported direct files, 25 MB each. It does not
walk subdirectories and ignores hidden files, symlinks, executables, source code, and
unsupported types. The model receives only each admitted file's basename, type, size,
and opaque document id—never its filesystem path. `/documents` shows the exact set.

For a workspace checkout, running the development entry point by absolute path keeps
the file boundary at your current directory:

```bash
cd ~/job-application
bun /path/to/mu/packages/browser-cli/src/main.ts --connection persistent --browser chromium
```

## Connection modes

`--connection <mode>` selects how `mu-browser` reaches a browser. There are three:

| Mode | What it is |
| --- | --- |
| `extension` (default) | Attaches to a tab in a browser you already have open, through the Playwright browser extension, after you approve the connection there. Your logged-in state never leaves your browser. |
| `persistent` | Launches a browser Mu owns outright, under a profile directory in `~/.mu/browser/profiles`. Never your everyday browser profile. Can run `--headless`. |
| `fake` (alias `--fake-browser`) | A deterministic in-memory browser: no real site, no network. For trying the product, development, and CI. |

### What `doctor` tells you

`mu-browser doctor` resolves the Playwright bridge, checks whether the extension relay
can reach a browser from where Mu is running, and looks for an installed Chrome-family
executable — all without a network call or a launched browser. A mode it cannot reach
is reported as a note naming the environment variable that fixes it, not as a broken
install.

### Extension mode

You will need the Playwright browser extension installed in Chrome, Edge, or
Chromium, and a copy of that browser already running. The first time a session needs
the browser, `mu-browser` asks the extension to attach; you approve the connection in
your browser. If you decline or the approval times out, the tool reports "approve the
Playwright extension connection in your browser, then connect again" rather than
retrying silently. Shutting the session down detaches — it never closes a tab or
window that was yours to begin with.

`--headless` and `--browser-profile` are rejected with `extension`: the whole point
of this mode is a browser you can see, driving your own profile, not one Mu owns.

### Persistent mode

`mu-browser --connection persistent [--browser-profile <name>] [--headless]` launches
a browser under a profile Mu owns at `~/.mu/browser/profiles/<name>/` (`default` if
you don't name one). It is never a path into your own Chrome/Edge profile. Only one
`mu-browser` process may drive a given named profile at a time — a second attempt to
use the same name while the first is still running is refused, naming the PID that
holds it. Cookies and login state accumulate in that Mu-owned profile the way they
would in any browser profile you drove by hand; Mu does not read or export them (see
[PRIVACY.md](./PRIVACY.md)).

`--browser <chrome|edge|chromium>` selects which browser family to launch (default
`chrome`); the executable is discovered from a short list of standard install
locations for your OS, or from `MU_BROWSER_EXECUTABLE` if you set it. Mu never
downloads a browser binary itself — install one of the three normally first.

On Linux, a snap-packaged Chromium works for browsing and uploads, but its private
`/tmp` namespace prevents Playwright from handing downloaded files back to Mu. `doctor`
detects that packaging and reports the download limitation; use a non-snap Chrome-family
installation when downloads are part of the task.

### Running from WSL

If `mu-browser` runs inside WSL and the browser it needs to reach is the Windows-side
Chrome, `extension` mode needs a relay hosted on Windows, not inside WSL — a
WSL-hosted relay connects but never completes the extension handshake, and times out
after 90 seconds instead of working. Set:

- `MU_BROWSER_MCP_RUNTIME` to the Windows path of `node.exe`
- `MU_BROWSER_MCP_CLI` to the Windows path of the Playwright MCP `cli.js`

or use `--connection persistent` instead, which launches its own browser and has no
such requirement.

## Upgrading

```bash
npm install --global @mu-agent/browser@latest
```

`mu-browser` never re-downloads or updates the browser bridge it depends on by
itself — that dependency is pinned to an exact version and ships inside the package,
so upgrading the browser bridge means upgrading `@mu-agent/browser`. If a connection
ever reports a version mismatch on the bridge, reinstalling the package (rather than
anything else) is the fix. `mu-browser -v` prints the installed version.

Session transcripts, receipts, and other data under `~/.mu/browser/` are untouched by
an upgrade.

## Uninstalling

```bash
npm uninstall --global @mu-agent/browser
```

This removes the CLI only. It does not touch `~/.mu/browser/` — your sessions,
receipts, and any persistent browser profile stay on disk until you remove them
yourself. See [PRIVACY.md](./PRIVACY.md#removing-your-data) for the exact command.
There is no `mu-browser self uninstall` or `--purge`; that is a coding-product
command this product does not ship.
