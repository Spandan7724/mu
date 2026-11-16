import { expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentMessage, ExtensionHost } from "mu";
import { parseArgs } from "./args.ts";
import { FOLDERS_CONTEXT_TYPE, sessionFolders } from "./folders.ts";

const scratch = async () => realpath(await mkdtemp(join(tmpdir(), "mu-folders-")));

async function setup(flagged: string[] = []) {
  const cwd = await scratch();
  const sessions = new Map<string, AgentMessage[]>([["a", []]]);
  let current = "a";
  const folders = sessionFolders({
    cwd,
    flagged,
    skillFolders: () => ["/skills"],
    session: () => ({ id: current, messages: () => sessions.get(current) ?? [] }),
  });
  const host = new ExtensionHost();
  await host.register(folders.extension);
  const run = async (args: string) =>
    (await host.commands.get("add-dir")?.run({
      args,
      inject: () => {},
      print: () => {},
      getModel: () => "",
      setModel: () => {},
    })) as { message: string };
  // What a run would append before its first model call.
  const context = async () => {
    const messages = sessions.get(current) ?? [];
    const added = await host.runContextProviders(messages, { sessionId: current });
    messages.push(...added);
    return added;
  };
  const switchTo = (id: string, messages: AgentMessage[] = []) => {
    sessions.set(id, messages);
    current = id;
  };
  return { cwd, folders, run, context, switchTo, sessions };
}

test("/add-dir adds a folder to this session only, and it survives resume", async () => {
  const { folders, run, context, switchTo, sessions } = await setup();
  const added = await scratch();

  expect((await run(added)).message).toContain(`Added ${added}`);
  expect(folders.reach()).toEqual([added, "/skills"]);

  const [snapshot] = await context();
  expect(snapshot).toMatchObject({ customType: FOLDERS_CONTEXT_TYPE, details: { added: [added] } });
  expect(await context()).toEqual([]);

  switchTo("b");
  expect(folders.reach()).toEqual(["/skills"]);

  switchTo("a", sessions.get("a"));
  expect(folders.reach()).toEqual([added, "/skills"]);
});

test("--add-dir folders last for the process and are listed", async () => {
  const flagged = await scratch();
  const { folders, run, switchTo } = await setup([flagged]);
  switchTo("other");
  expect(folders.reach()).toEqual([flagged, "/skills"]);
  const listing = (await run("")).message;
  expect(listing).toContain(`${flagged}  (--add-dir)`);
  expect(listing).toContain("1 skill folders");
});

test("/add-dir refuses files, missing paths and folders already reachable", async () => {
  const { cwd, folders, run } = await setup();
  await writeFile(join(cwd, "file.txt"), "x");
  expect((await run(join(cwd, "file.txt"))).message).toContain("is not a directory");
  expect((await run(join(cwd, "missing"))).message).toContain("does not exist");
  expect((await run(".")).message).toContain("already reachable");
  expect(folders.reach()).toEqual(["/skills"]);
});

test("--add-dir is repeatable and needs a folder", () => {
  expect(parseArgs(["--add-dir", "a", "--add-dir", "b"]).addDirs).toEqual(["a", "b"]);
  expect(parseArgs(["--add-dir"]).errors).toContain("--add-dir requires a folder");
});
