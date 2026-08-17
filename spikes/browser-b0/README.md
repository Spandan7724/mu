# Browser B0 feasibility spike

This directory is deliberately isolated from Mu's workspaces and production packages. It
exists only to reproduce the B0 bridge and persistent-profile checks recorded in
`docs/browser/B0-EVIDENCE.md`.

Safety rules:

- use only the exact dependency versions in this directory;
- never run the extension scenario with `PLAYWRIGHT_MCP_EXTENSION_TOKEN` set;
- use the loopback fixture rather than a real account;
- never request cookies, storage state, authorization headers, passwords, or profile files;
- use a dedicated disposable user-data directory for persistent mode;
- do not copy any spike module into `packages/`.

The MCP client is intentionally a small JSON-RPC/stdio probe. It validates the sidecar
boundary Mu is expected to adapt; it is not a production driver implementation.

## Supported test topology

Run the extension relay on the same operating system as the browser. For Windows Chrome
with Mu or the probe client in WSL, keep the client in WSL but launch the sidecar with
Windows Node:

```bash
export B0_SIDECAR_RUNTIME='/mnt/c/Program Files/nodejs/node.exe'
export B0_SIDECAR_CLI
B0_SIDECAR_CLI=$(wslpath -w "$PWD/node_modules/@playwright/mcp/cli.js")
bun run mcp-client.ts --extension --browser chrome --calls \
  '[{"name":"browser_snapshot","arguments":{}}]'
```

Each extension URL contains a relay-specific port and UUID. It is valid only while that
sidecar is alive; never refresh or reuse an old connection page. A real driver must keep
one sidecar alive for the browser session instead of launching a new relay per action.
