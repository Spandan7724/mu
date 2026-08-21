// Public surface of the browser profile. Owned by the integration gate: lanes add
// modules under src/ and the barrel is wired when their work merges.
// The driver conformance harness is deliberately not re-exported here — it is
// test-only and reachable at @mu/profile-browser/testing.
export * from "./artifacts/index.ts";
export * from "./contracts/index.ts";
export * from "./data/index.ts";
export * from "./policy/index.ts";
