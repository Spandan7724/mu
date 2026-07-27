import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadUserConfig,
  resolveCliModel,
  saveDefaultModel,
  saveDefaultPermissionMode,
  userConfigPath,
} from "./config.ts";

describe("user model configuration", () => {
  test("the user config lives under ~/.mu", () => {
    expect(userConfigPath("/users/test")).toBe(join("/users/test", ".mu", "config.json"));
  });

  test("saving a model preserves unrelated user settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-user-config-"));
    const file = join(root, "config.json");
    await Bun.write(
      file,
      JSON.stringify({
        mcpServers: { docs: { command: "docs-server" } },
        theme: "quiet",
      }),
    );

    await saveDefaultModel("openai/gpt-5.1", file);

    expect(await loadUserConfig(file)).toEqual({
      mcpServers: { docs: { command: "docs-server" } },
      theme: "quiet",
      model: "openai/gpt-5.1",
    });
  });

  test("the saved model becomes the default but an explicit flag wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-model-default-"));
    const file = join(root, "config.json");
    await saveDefaultModel("openai/gpt-5.1", file);

    expect(await resolveCliModel(undefined, file)).toBe("openai/gpt-5.1");
    expect(await resolveCliModel("anthropic/claude-opus-5", file)).toBe("anthropic/claude-opus-5");
  });

  test("permission modes are saved per profile without losing other settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-permission-default-"));
    const file = join(root, "config.json");
    await saveDefaultModel("openai/gpt-5.1", file);
    await saveDefaultPermissionMode("coding", "accept-edits", file);
    await saveDefaultPermissionMode("automation", "locked-down", file);

    expect(await loadUserConfig(file)).toEqual({
      model: "openai/gpt-5.1",
      permissionModes: {
        coding: "accept-edits",
        automation: "locked-down",
      },
    });
  });

  test("an unavailable saved model falls back to the catalog default", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-stale-model-"));
    const file = join(root, "config.json");
    await writeFile(file, JSON.stringify({ model: "gone/no-longer-listed" }));

    expect(await resolveCliModel(undefined, file)).not.toBe("gone/no-longer-listed");
  });

  test("a non-string model value is ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-invalid-model-"));
    const file = join(root, "config.json");
    await writeFile(file, JSON.stringify({ model: 42 }));

    expect(await resolveCliModel(undefined, file)).not.toBe("42");
  });

  test("a malformed config is ignored when reading but not overwritten when saving", async () => {
    const root = await mkdtemp(join(tmpdir(), "mu-bad-config-"));
    const file = join(root, "config.json");
    await writeFile(file, "{ broken");

    expect(await loadUserConfig(file)).toEqual({});
    await expect(saveDefaultModel("openai/gpt-5.1", file)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{ broken");
  });
});
