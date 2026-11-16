import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveRipgrepExecutable } from "@mu/profile-coding";
import { FileMentions } from "./file-mentions.ts";

const ripgrep = resolveRipgrepExecutable();

let root: string;

async function files(paths: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(paths)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function built(options: { ripgrep?: string | undefined; limit?: number } = {}) {
  const mentions = new FileMentions({ root, ...options });
  await mentions.refresh();
  return mentions;
}

const labels = (items: { label: string }[]) => items.map((item) => item.label);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mu-mentions-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const junk = {
  "app.py": "",
  "__pycache__/app.cpython-314.pyc": "",
  "venv/lib/site.py": "",
  ".venv/lib/site.py": "",
  "target/debug/app.o": "",
  "src/Main.class": "",
  "src/main.py": "",
};

describe.each([
  ["ripgrep", ripgrep],
  ["walk", undefined],
])("search with %s", (_name, executable) => {
  test("leaves out junk and dotfiles even without ignore files", async () => {
    await files({ ...junk, ".env": "" });
    const mentions = await built({ ripgrep: executable });
    expect(labels(mentions.query("")).sort()).toEqual(["app.py", "src/", "src/main.py"]);
  });

  test("ranks file-name prefix matches over deeper path matches", async () => {
    await files({ "lib/app/index.ts": "", "src/apple.ts": "", "my-app.ts": "", "z/app.ts": "" });
    const mentions = await built({ ripgrep: executable });
    expect(labels(mentions.query("app"))).toEqual([
      "lib/app/",
      "src/apple.ts",
      "z/app.ts",
      "my-app.ts",
      "lib/app/index.ts",
    ]);
  });

  test("folders are searchable and sort with the files beside them", async () => {
    await files({ "src/api/client.ts": "", "README.md": "", "zed.ts": "" });
    const mentions = await built({ ripgrep: executable });
    expect(labels(mentions.query(""))).toEqual([
      "README.md",
      "src/",
      "zed.ts",
      "src/api/",
      "src/api/client.ts",
    ]);
    expect(labels(mentions.query("ap"))).toEqual(["src/api/", "src/api/client.ts"]);
  });

  test("matches case-insensitively and caps results", async () => {
    await files(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Readme${i}.md`, ""])));
    const mentions = await built({ ripgrep: executable, limit: 5 });
    expect(mentions.query("readme")).toHaveLength(5);
  });
});

describe.if(ripgrep !== undefined)("ignore rules", () => {
  test("a git repo hides ignored files and shows uncommitted ones", async () => {
    await files({
      ".gitignore": "secret.txt\nout/\n",
      "secret.txt": "",
      "out/a.js": "",
      "new.ts": "",
    });
    await mkdir(join(root, ".git"));
    const mentions = await built({ ripgrep });
    expect(labels(mentions.query(""))).toEqual(["new.ts"]);
  });

  test(".gitignore applies outside a git repo", async () => {
    await files({ ".gitignore": "out/\n", "out/a.js": "", "keep.ts": "" });
    const mentions = await built({ ripgrep });
    expect(labels(mentions.query(""))).toEqual(["keep.ts"]);
    expect(labels(mentions.query("out"))).toEqual([]);
  });

  test("build and dist are listed unless ignored", async () => {
    await files({ "build/gen.ts": "", "dist/x.js": "" });
    const mentions = await built({ ripgrep });
    expect(labels(mentions.query("")).sort()).toEqual([
      "build/",
      "build/gen.ts",
      "dist/",
      "dist/x.js",
    ]);
  });
});

describe("folder listing", () => {
  test("a slash lists the folder on disk, ignored files and dotfiles included, .git not", async () => {
    await files({ ".gitignore": "local.json\n", "config/local.json": "", "config/.env": "" });
    await mkdir(join(root, "config/nested"));
    await mkdir(join(root, ".git"));
    const mentions = await built({ ripgrep });
    expect(labels(mentions.query("config/"))).toEqual([
      "config/.env",
      "config/local.json",
      "config/nested/",
    ]);
    expect(labels(mentions.query("./"))).toEqual(["./.gitignore", "./config/"]);
  });

  test("the part after the slash filters by name, prefix first", async () => {
    await files({ "src/lib-app.ts": "", "src/app.ts": "", "src/b.ts": "" });
    const mentions = await built();
    expect(labels(mentions.query("src/APP"))).toEqual(["src/app.ts", "src/lib-app.ts"]);
  });

  test("a missing folder lists nothing", async () => {
    const mentions = await built();
    expect(mentions.query("nope/")).toEqual([]);
  });

  test("before the index lands, the root folder answers without junk", async () => {
    await files(junk);
    const mentions = new FileMentions({ root, ripgrep });
    expect(labels(mentions.query(""))).toEqual(["app.py", "src/"]);
  });
});

test("opening the popup again picks up new files and reports when ready", async () => {
  await files({ "a.ts": "" });
  let ready = 0;
  const mentions = new FileMentions({ root, ripgrep, onReady: () => ready++ });
  await mentions.refresh();
  await files({ "b.ts": "" });
  mentions.query("");
  await mentions.refresh();
  expect(labels(mentions.query("")).sort()).toEqual(["a.ts", "b.ts"]);
  expect(ready).toBe(2);
});

test("an index past maxFiles is cut, not unbounded", async () => {
  await files(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.ts`, ""])));
  const mentions = new FileMentions({ root, ripgrep, maxFiles: 8, limit: 50 });
  await mentions.refresh();
  expect(mentions.query("")).toHaveLength(8);
});
