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
