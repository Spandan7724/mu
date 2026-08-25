# Setup

## Install

```bash
npm install --global @mu-agent/browser
mu-browser doctor    # read-only check: no network call, no browser launched
```

`mu-browser doctor` reports the private data root, checks the pinned Playwright MCP
sidecar, and looks for an installed Chrome-family browser.

## Local files

The directory where you start `mu-browser` is the session's local-file boundary. Put
documents you want it to reference or upload directly in that directory:

```bash
cd ~/job-application
mu-browser --browser chromium
```

Mu admits up to 100 supported direct files, 25 MB each. It does not walk
subdirectories and ignores hidden files, symlinks, executables, source code, and
unsupported types. The model receives only each admitted file's basename, type, size,
and opaque document id—never its filesystem path. `/documents` shows the exact set.

When running the development entry point from another directory, use its absolute path:

```bash
cd ~/job-application
bun /path/to/mu/packages/browser-cli/src/main.ts --browser chromium
```

## Mu-owned browser profiles

`mu-browser` always launches a browser it owns. The default profile lives at
`~/.mu/browser/profiles/default/`; name another persistent profile with:

```bash
mu-browser --browser-profile work
```

Cookies, history, local storage, and login state persist in that profile across
sessions. It is never a path into your everyday Chrome or Edge profile. Only one
`mu-browser` process may drive a named profile at a time; a second process is refused
with the PID holding its ownership lock.

`--browser <chrome|edge|chromium>` selects the installed browser family (default
`chrome`). Set `MU_BROWSER_EXECUTABLE` to an exact executable path when discovery
cannot find it. Mu never downloads a browser binary.

Use `--headless` to launch the same Mu-owned profile without a visible window.
`--fake-browser` selects a deterministic in-memory browser for development and CI; it
does not visit a website or start a browser process.

On Linux, snap Chromium works for browsing and uploads, but its private `/tmp`
namespace prevents Playwright from handing downloaded files back to Mu. `doctor`
reports this limitation; use a non-snap Chrome-family browser when downloads matter.

## WSL

A browser launched inside WSL needs a Linux Chrome-family executable and a working GUI
forwarding environment. A Windows `chrome.exe` cannot be driven from a Linux process
through Playwright's inherited debugging pipe. For a normal visible Windows browser,
run `mu-browser` natively on Windows instead.

## Upgrading and uninstalling

```bash
npm install --global @mu-agent/browser@latest
npm uninstall --global @mu-agent/browser
```

The Playwright MCP dependency is exact-pinned and shipped with the package; Mu never
runs `npx` or silently updates it. Upgrading or uninstalling the CLI does not remove
`~/.mu/browser/`, including persistent profiles, sessions, documents, and receipts.
See [PRIVACY.md](./PRIVACY.md) for removal instructions.
