import { describe, expect, test } from "bun:test";
import { browserObservationSchema } from "../contracts/observation.ts";
import {
  FAKE_LABELS,
  FAKE_ORIGIN,
  FAKE_PAGE_URLS,
  type FakeElementSpec,
  type FakePageSpec,
} from "../drivers/fake/site.ts";
import { browserActTool } from "./act.ts";
import { createHarness } from "./harness.ts";
import { elementSignature, observationDigest } from "./observation.ts";

const signal = () => new AbortController().signal;

function mutablePage(elements: FakeElementSpec[]): {
  pages: Map<string, FakePageSpec>;
  url: string;
  set: (next: FakeElementSpec[]) => void;
} {
  const url = `${FAKE_ORIGIN}/mutable`;
  const build = (specs: FakeElementSpec[]): FakePageSpec => ({
    url,
    title: "Mutable page",
    summary: "A page a script rewrites.",
    elements: specs,
  });
  const pages = new Map<string, FakePageSpec>([[url, build(elements)]]);
  return { pages, url, set: (next) => pages.set(url, build(next)) };
}

const textbox = (ref: string, label: string, value = ""): FakeElementSpec => ({
  ref,
  role: "textbox",
  name: label,
  label,
  inputType: "text",
  value,
});

describe("the observation ledger", () => {
  test("references are opaque session tokens, not the driver's own identifiers", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      await harness.session.observe({}, signal());
      await harness.runtime.use(
        (driver) => driver.navigate({ kind: "url", url: FAKE_PAGE_URLS.form }, signal()),
        signal(),
      );
      const record = await harness.session.observe({}, signal());
      const refs = record.observation.elements.map((element) => element.ref);
      expect(refs.length).toBeGreaterThan(0);
      // The fake driver names its controls e1..e7. None of that reaches the model.
      for (const ref of refs) expect(ref).toMatch(/^r\d+$/);
      for (const target of record.targets.values()) {
        expect(target.driverRef.ref).not.toBe(target.element.ref);
      }
      // And what is handed out still satisfies the observation contract.
      expect(() => browserObservationSchema.parse(record.observation)).not.toThrow();
    } finally {
      await harness.shutdown();
    }
  });

  test("observing an unchanged page keeps the revision, so a reference survives", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const first = await harness.session.observe({}, signal());
      const second = await harness.session.observe({}, signal());
      expect(second.revision).toBe(first.revision);
      const ref = first.observation.elements[0];
      expect(ref).toBeDefined();
      const resolution = harness.session.resolve(
        ref as NonNullable<typeof ref>,
        harness.session.record() as NonNullable<ReturnType<typeof harness.session.record>>,
      );
      expect(resolution.kind).toBe("resolved");
    } finally {
      await harness.shutdown();
    }
  });

  test("entering a value does not invalidate the references around it", async () => {
    const page = mutablePage([textbox("a", "First"), textbox("b", "Second")]);
    const harness = createHarness({
      site: { origin: FAKE_ORIGIN, landingUrl: page.url, pages: page.pages },
      allowedOrigins: [FAKE_ORIGIN],
    });
    try {
      const act = browserActTool({ session: harness.session });
      const before = await harness.session.observe({}, signal());
      const first = before.observation.elements[0] as NonNullable<
        (typeof before.observation.elements)[0]
      >;
      const second = before.observation.elements[1];
      await act.execute(
        "call-1",
        {
          action: "fill",
          target: { ref: first.ref, revision: first.revision, tabId: first.tabId },
          value: "Ada Lovelace",
        },
        signal(),
      );
      const after = await harness.session.observe({}, signal());
      // Structure unchanged, so the reference the model already holds still resolves.
      expect(after.revision).toBe(before.revision);
      expect(harness.session.resolve(second as NonNullable<typeof second>, after).kind).toBe(
        "resolved",
      );
    } finally {
      await harness.shutdown();
    }
  });

  test("a control replaced in place invalidates every reference on the page", async () => {
    const page = mutablePage([
      textbox("note", "Note"),
      { ref: "primary", role: "button", name: "Submit application", label: "Submit application" },
    ]);
    const harness = createHarness({
      site: { origin: FAKE_ORIGIN, landingUrl: page.url, pages: page.pages },
      allowedOrigins: [FAKE_ORIGIN],
    });
    try {
      const before = await harness.session.observe({}, signal());
      const primary = before.observation.elements[1];
      page.set([
        textbox("note", "Note"),
        { ref: "primary", role: "button", name: "Delete draft", label: "Delete draft" },
      ]);
      const after = await harness.session.observe({}, signal());
      expect(after.revision).not.toBe(before.revision);
      const resolution = harness.session.resolve(primary as NonNullable<typeof primary>, after);
      expect(resolution.kind).toBe("stale");
      // The twin exists, under an identity of its own.
      const twin = after.observation.elements[1];
      expect(twin?.name).toBe("Delete draft");
      expect(twin?.ref).not.toBe(primary?.ref);
    } finally {
      await harness.shutdown();
    }
  });

  test("navigation, tab changes and takeover each drop the references they invalidate", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const first = await harness.session.observe({}, signal());
      harness.session.invalidate(first.tabId);
      expect(harness.session.record(first.tabId)).toBeUndefined();

      const second = await harness.session.observe({}, signal());
      harness.session.beginTakeover({
        reason: "login",
        instructions: "sign in",
        startedAt: 0,
        tabId: second.tabId,
        url: second.observation.url,
      });
      expect(harness.session.record(second.tabId)).toBeUndefined();
      expect(harness.session.takeover?.reason).toBe("login");
    } finally {
      await harness.shutdown();
    }
  });

  test("a reference from another tab is refused rather than applied to this one", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const record = await harness.session.observe({}, signal());
      const element = record.observation.elements[0] as NonNullable<
        (typeof record.observation.elements)[0]
      >;
      const resolution = harness.session.resolve({ ...element, tabId: "fake-tab-99" }, record);
      expect(resolution.kind).toBe("stale");
      if (resolution.kind === "stale") expect(resolution.validity).toBe("wrong-tab");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("structural identity", () => {
  test("a signature changes with what a rerender changes and not with what typing changes", () => {
    const base = {
      ref: "r1" as never,
      revision: 1,
      tabId: "t",
      role: "button",
      name: "Submit application",
    };
    const typed = { ...base, value: "Ada" };
    const renamed = { ...base, name: "Delete draft" };
    expect(elementSignature(typed, 0)).toBe(elementSignature(base, 0));
    expect(elementSignature(renamed, 0)).not.toBe(elementSignature(base, 0));
    // Position is part of identity: the same control moved is not the same reference.
    expect(elementSignature(base, 1)).not.toBe(elementSignature(base, 0));
  });

  test("the page digest follows the URL, the frames and every control", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      const first = await harness.session.observe({}, signal());
      const same = observationDigest(first.observation);
      expect(same).toBe(first.digest);
      const moved = observationDigest({ ...first.observation, url: `${FAKE_ORIGIN}/elsewhere` });
      expect(moved).not.toBe(first.digest);
    } finally {
      await harness.shutdown();
    }
  });
});

describe("the audit trail", () => {
  test("it records what was done, where, and under which permission", async () => {
    const harness = createHarness({ allowedOrigins: [FAKE_ORIGIN] });
    try {
      harness.session.note({
        tool: "browser_act",
        action: "fill",
        tabId: "fake-tab-1",
        url: `${FAKE_ORIGIN}${FAKE_PAGE_URLS.form}`,
        outcome: "completed",
        scope: "browser:disclose",
        pattern: `${FAKE_ORIGIN} ${FAKE_LABELS.textField}`,
      });
      const entry = harness.session.audit.at(-1);
      expect(entry?.scope).toBe("browser:disclose");
      expect(entry?.outcome).toBe("completed");
    } finally {
      await harness.shutdown();
    }
  });
});

describe("a reference survives the page moving around it", () => {
  const banner = (ref: string): FakeElementSpec => ({
    ref,
    role: "button",
    name: "Accept cookies",
    label: "Accept cookies",
  });

  async function open(page: ReturnType<typeof mutablePage>) {
    const harness = createHarness({
      allowedOrigins: [FAKE_ORIGIN],
      site: { origin: FAKE_ORIGIN, landingUrl: page.url, pages: page.pages },
    });
    await harness.runtime.use(
      (driver) => driver.navigate({ kind: "url", url: page.url }, signal()),
      signal(),
    );
    return harness;
  }

  const refTo = (harness: Awaited<ReturnType<typeof open>>, label: string) => {
    const element = harness.session
      .record()
      ?.observation.elements.find((entry) => entry.label === label);
    if (element === undefined) throw new Error(`no control labelled ${label}`);
    return { ref: element.ref, revision: element.revision, tabId: element.tabId };
  };

  // The case that made the product unusable on a real site: a banner appears, every
  // index below it shifts, and a reference to an untouched control dies.
  test("an unrelated control appearing does not kill a reference", async () => {
    const page = mutablePage([textbox("e1", "Full name"), textbox("e2", "Email")]);
    const harness = await open(page);
    await harness.session.observe({}, signal());
    const email = refTo(harness, "Email");

    page.set([banner("e9"), textbox("e1", "Full name"), textbox("e2", "Email")]);
    const after = await harness.session.observe({}, signal());

    expect(after.revision).not.toBe(email.revision);
    const resolved = harness.session.resolve(email, after);
    expect(resolved.kind).toBe("resolved");
    await harness.shutdown();
  });

  test("the control itself changing still kills the reference", async () => {
    const page = mutablePage([textbox("e1", "Full name"), textbox("e2", "Email")]);
    const harness = await open(page);
    await harness.session.observe({}, signal());
    const email = refTo(harness, "Email");

    page.set([textbox("e1", "Full name"), textbox("e2", "Work email")]);
    const after = await harness.session.observe({}, signal());
    expect(harness.session.resolve(email, after).kind).toBe("stale");
    await harness.shutdown();
  });

  test("a control replaced by a different node at the same place is not the same control", async () => {
    const page = mutablePage([textbox("e1", "Full name"), textbox("e2", "Email")]);
    const harness = await open(page);
    await harness.session.observe({}, signal());
    const email = refTo(harness, "Email");

    // Same label, different underlying node: the driver ref is what catches this.
    page.set([textbox("e1", "Full name"), textbox("e7", "Email")]);
    const after = await harness.session.observe({}, signal());
    expect(harness.session.resolve(email, after).kind).toBe("stale");
    await harness.shutdown();
  });
});
