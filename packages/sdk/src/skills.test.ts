import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHost } from "@mu/core";
import { FakeProvider, fakeModel } from "@mu/core/testing/fake-provider.ts";
import { Agent } from "./agent.ts";
import { discoverSkills, loadSkill, skillListing, skillsExtension } from "./skills.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mu-skills-"));
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
}

describe("skill discovery", () => {
  test("reads name and description from frontmatter", async () => {
    const root = await scratch();
    await writeSkill(
      root,
      "pdf",
      "---\nname: pdf\ndescription: Fill in PDF forms\n---\nStep one. Step two.",
    );

    const skill = await loadSkill(join(root, "pdf"));
    expect(skill?.name).toBe("pdf");
    expect(skill?.description).toBe("Fill in PDF forms");
    expect(skill?.body).toBe("Step one. Step two.");
  });

  test("falls back to the directory name", async () => {
    const root = await scratch();
    await writeSkill(root, "fallback", "No frontmatter here.");
    expect((await loadSkill(join(root, "fallback")))?.name).toBe("fallback");
  });

  test("a directory without SKILL.md is not a skill", async () => {
    const root = await scratch();
    await mkdir(join(root, "not-a-skill"), { recursive: true });
    expect(await loadSkill(join(root, "not-a-skill"))).toBeUndefined();
  });

  test("discovers every skill under the given roots", async () => {
    const user = await scratch();
    const project = await scratch();
    await writeSkill(user, "alpha", "---\ndescription: A\n---\nbody");
    await writeSkill(project, "beta", "---\ndescription: B\n---\nbody");

    const skills = await discoverSkills([user, project]);
    expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  test("missing roots are skipped", async () => {
    expect(await discoverSkills([join(tmpdir(), "absent-mu-skills")])).toEqual([]);
  });
});

describe("progressive disclosure", () => {
  test("the listing carries descriptions only, not bodies", async () => {
    const root = await scratch();
    await writeSkill(
      root,
      "pdf",
      "---\nname: pdf\ndescription: Fill in PDF forms\n---\nVERY LONG BODY".padEnd(500, "x"),
    );
    const skills = await discoverSkills([root]);
    const listing = skillListing(skills);

    expect(listing).toContain("pdf: Fill in PDF forms");
    expect(listing).not.toContain("VERY LONG BODY");
  });

  test("an empty set produces no listing", () => {
    expect(skillListing([])).toBe("");
  });
});

describe("skills as an extension", () => {
  test("registers a skill tool through the public API only", async () => {
    const root = await scratch();
    await writeSkill(root, "pdf", "---\nname: pdf\ndescription: Fill PDFs\n---\nDetailed steps.");
    const skills = await discoverSkills([root]);

    const host = new ExtensionHost();
    await host.register(skillsExtension(skills));

    expect(host.tools.has("skill")).toBe(true);
    // The tool description carries the listing, so the model can choose.
    expect(host.tools.get("skill")?.description).toContain("Fill PDFs");
  });

  test("the model loads a skill body on demand", async () => {
    const root = await scratch();
    await writeSkill(
      root,
      "deploy",
      "---\nname: deploy\ndescription: How to ship\n---\nRun the release script, then tag.",
    );
    const skills = await discoverSkills([root]);
    const host = new ExtensionHost();
    await host.register(skillsExtension(skills));

    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "skill", arguments: { name: "deploy" } }] },
      { content: [{ type: "text", text: "Following the deploy skill." }] },
    ]);
    const agent = new Agent({ provider, model: fakeModel, extensions: host });
    const result = await agent.run("ship it");

    const loaded = result.messages.find((m) => m.role === "toolResult");
    expect(
      loaded?.role === "toolResult" && loaded.content[0]?.type === "text" && loaded.content[0].text,
    ).toContain("Run the release script, then tag.");
  });

  test("an unknown skill lists what is available instead of failing silently", async () => {
    const root = await scratch();
    await writeSkill(root, "real", "---\ndescription: R\n---\nbody");
    const host = new ExtensionHost();
    await host.register(skillsExtension(await discoverSkills([root])));

    const provider = new FakeProvider([
      { content: [{ type: "toolCall", id: "c1", name: "skill", arguments: { name: "missing" } }] },
      { content: [{ type: "text", text: "ok" }] },
    ]);
    const result = await new Agent({ provider, model: fakeModel, extensions: host }).run("go");

    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
    expect(
      toolResult?.role === "toolResult" &&
        toolResult.content[0]?.type === "text" &&
        toolResult.content[0].text,
    ).toContain("real");
  });

  test("with no skills installed the extension registers nothing", async () => {
    const host = new ExtensionHost();
    await host.register(skillsExtension([]));
    expect(host.tools.has("skill")).toBe(false);
  });
});
