import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { liveHolder, ProfileInUseError, ProfileLease } from "./lease.ts";

const dirs: string[] = [];
const profileDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mu-lease-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = (pid: number) =>
  JSON.stringify({ pid, host: hostname(), token: "other", since: "2026-10-11T00:00:00.000Z" });

test("one holder at a time; release lets the next session in", () => {
  const dir = profileDir();
  const first = new ProfileLease(dir, "work");
  first.acquire();
  first.acquire();
  expect(liveHolder(dir)?.pid).toBe(process.pid);
  expect(() => new ProfileLease(dir, "work").acquire()).toThrow(ProfileInUseError);
  first.release();
  expect(liveHolder(dir)).toBeUndefined();
  const second = new ProfileLease(dir, "work");
  second.acquire();
  second.release();
});

test("a dead holder's record does not block", async () => {
  const dir = profileDir();
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  writeFileSync(join(dir, "mu-session.json"), record(gone.pid));
  expect(liveHolder(dir)).toBeUndefined();
  const lease = new ProfileLease(dir, "work");
  lease.acquire();
  expect(liveHolder(dir)?.pid).toBe(process.pid);
  lease.release();
});

test("a record whose heartbeat stopped does not block, even if its pid is reused", () => {
  const dir = profileDir();
  const path = join(dir, "mu-session.json");
  writeFileSync(path, record(process.ppid));
  expect(liveHolder(dir)?.pid).toBe(process.ppid);
  const old = new Date(Date.now() - 120_000);
  utimesSync(path, old, old);
  expect(liveHolder(dir)).toBeUndefined();
  const lease = new ProfileLease(dir, "work");
  lease.acquire();
  lease.release();
});

test("an unreadable record is replaced", () => {
  const dir = profileDir();
  writeFileSync(join(dir, "mu-session.json"), "{not json");
  const lease = new ProfileLease(dir, "work");
  lease.acquire();
  expect(liveHolder(dir)?.pid).toBe(process.pid);
  lease.release();
});
