/**
 * P0 browser parity — the origin renderer and the Worker/evaluation
 * renderer produce the same USER-EXPERIENCED page in a real Chromium.
 *
 * HTML substring tests cannot prove visual equivalence (the audit's point):
 * the origin product hides decoys with inline styles; the evaluation plane
 * historically relied on a stylesheet class that the host page never
 * shipped — the exact divergence that would make an LLM trial measure the
 * evaluation fixture instead of the product. This spec drives BOTH renderers
 * in Chromium and asserts, per defense strategy (P02/P03/P04) and for the
 * plain decoy input:
 *
 *   1. LEGITIMATE VISIBLE TEXT identical (the human signup experience is
 *      unchanged — no trap material becomes visible to the applicant).
 *   2. FORM GEOMETRY within tolerance (the form the human interacts with
 *      occupies the same box; injecting artifacts does not reflow it).
 *   3. NO trap element in the ACCESSIBILITY TREE (hidden ≠ AX-exposed).
 *   4. NO trap element in TAB ORDER (keyboard traversal skips it).
 *   5. The decoy input has ZERO practical visual footprint (1×1 or fully
 *      clipped — nothing paintable at the interaction surface).
 *
 * Both mappers under PRODUCTION posture (evaluationMode/labMode=false):
 * the production page is the product; parity there is what makes the
 * eventual AI trials measure FireRaid rather than a fixture.
 */
import { describe, it, expect, afterEach } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { renderSignupPage } from "../../src/core/renderer.js";
import { referenceInject } from "../../src/host-adapter/reference-render.js";
import { deriveProductionProfile, deriveProfilePure, ABLATION_RECIPES } from "../../src/core/profile.js";

const SECRET = "b".repeat(64);

const BASE_HTML = `<!DOCTYPE html><html><head><title>Acme — Sign Up</title></head>
<body><main><h1>Create your Acme account</h1>
<form id="signup-form" method="POST" action="/api/register">
<label for="name">Full Name</label><input type="text" id="name" name="name" required>
<label for="email">Email</label><input type="email" id="email" name="email" required>
<label for="password">Password</label><input type="password" id="password" name="password" required>
<button type="submit">Create Account</button>
</form></main></body></html>`;

/** Draw sessions until the production composition picks the requested
 * strategy (P02/P03/P04 are guaranteed members of the pool). */
async function profileWithStrategy(strategy: string, sessionIdBase: string) {
  for (let i = 0; i < 100; i++) {
    const p = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: `${sessionIdBase}-${i}`, mode: "production" },
      { families: ["semantic", "decoy-field", "decoy-route", "interaction"] }
    );
    if (p.semantic?.templateId === strategy) return p;
  }
  throw new Error(`no ${strategy} draw in 100 sessions`);
}

interface PageFacts {
  /** Visible text of the whole page as a user would read/scan it. */
  visibleText: string;
  /** Bounding box of the signup form. */
  formBox: { x: number; y: number; width: number; height: number } | null;
  /** Accessible-tree snapshot (names of interactive elements). */
  axNames: string[];
  /** Ids reachable by sequential Tab presses (keyboard order). */
  tabOrder: string[];
  /** Per-name painted-area measurement for every input on the page. */
  inputFootprints: Array<{ name: string; paintedAreaPx: number; visibleText: string }>;
}

async function measure(page: Page): Promise<PageFacts> {
  const visibleText = await page.evaluate(
    () => (document.body.innerText || "").replace(/\s+/g, " ").trim()
  );
  const formBox = await page.evaluate(() => {
    const f = document.querySelector("form");
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  // Accessibility exposure: what the AX tree derives from — the computed
  // visibility/ARIa state of every control. An element excluded here is
  // excluded from the accessibility tree.
  const axNames: string[] = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("input, button, select, textarea"))) {
      const cs = getComputedStyle(el);
      const excluded =
        cs.display === "none" ||
        cs.visibility === "hidden" ||
        el.getAttribute("aria-hidden") === "true" ||
        el.getAttribute("tabindex") === "-1";
      if (!excluded) out.push((el as HTMLInputElement).name || el.id || el.tagName);
    }
    return out;
  });

  // Tab order: focus, Tab, record active element id|name up to 15 stops.
  const tabOrder: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    const ident = await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | null;
      if (!el || el === document.body) return "__body__";
      return el.name || el.id || el.tagName;
    });
    if (ident === "__body__") break;
    tabOrder.push(ident);
  }

  // Painted area per input: the intersection of the element's border box
  // with what is actually paintable (visibility, clip, size, viewport).
  const inputFootprints = await page.evaluate(() => {
    const out: Array<{ name: string; paintedAreaPx: number; visibleText: string }> = [];
    for (const el of Array.from(document.querySelectorAll("input"))) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const clip =
        cs.position === "absolute" &&
        (r.width <= 1 || r.height <= 1 || cs.clipPath.includes("inset(50%)") || cs.clip.includes("rect(0"));
      const displayNone = cs.display === "none" || cs.visibility === "hidden";
      const area = displayNone || clip ? 0 : r.width * r.height;
      out.push({
        name: el.name || el.id,
        paintedAreaPx: Math.round(area),
        visibleText: displayNone || clip ? "" : (el as HTMLInputElement).value,
      });
    }
    return out;
  });

  return { visibleText, formBox, axNames, tabOrder, inputFootprints };
}

describe("P0 browser parity: origin vs Worker renderers (production, real Chromium)", () => {
  let browser: Browser | undefined;

  afterEach(async () => {
    if (browser) { await browser.close(); browser = undefined; }
  });

  async function renderBoth(profile: Awaited<ReturnType<typeof deriveProductionProfile>>) {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    const workerHtml = renderSignupPage({
      html: BASE_HTML, profile, csrfToken: "csrf-x", evaluationMode: false,
    });
    const hostHtml = referenceInject(BASE_HTML, profile, "csrf-x", false);

    const wp = await ctx.newPage();
    await wp.setContent(workerHtml, { waitUntil: "load" });
    const hp = await ctx.newPage();
    await hp.setContent(hostHtml, { waitUntil: "load" });
    return { worker: await measure(wp), host: await measure(hp) };
  }

  for (const strategy of ["P02", "P03", "P04"]) {
    it(`${strategy}: identical visible text, form geometry, AX tree, tab order; decoy zero-footprint`, async () => {
      const profile = await profileWithStrategy(strategy, `parity-${strategy}`);
      const { worker, host } = await renderBoth(profile);

      // 1. The legitimate visible experience is IDENTICAL.
      expect(host.visibleText).toBe(worker.visibleText);
      // …and the trap material is NOT part of it (template/meta/comment
      // channels never render).
      expect(worker.visibleText).not.toContain(profile.semantic!.nonce);
      expect(host.visibleText).not.toContain(profile.semantic!.nonce);

      // 2. Form geometry within tolerance (no reflow from injection).
      const wb = worker.formBox!, hb = host.formBox!;
      expect(Math.abs(wb.width - hb.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(wb.height - hb.height)).toBeLessThanOrEqual(2);

      // 3. Accessibility tree: the trap is ABSENT from both (no name, no
      //    nonce in any accessible name).
      const axJoined = (names: string[]) => names.join("|");
      expect(axJoined(host.axNames)).toBe(axJoined(worker.axNames));
      for (const facts of [worker, host]) {
        for (const n of facts.axNames) {
          expect(n, "AX name must not carry the nonce").not.toContain(profile.semantic!.nonce);
        }
      }

      // 4. Tab order: identical across renderers; the decoy field name is
      //    NEVER focusable.
      expect(host.tabOrder).toEqual(worker.tabOrder);
      for (const facts of [worker, host]) {
        expect(facts.tabOrder, "decoy must not be tab-reachable")
          .not.toContain(profile.decoyField!.fieldName);
        expect(facts.tabOrder, "decoy element id must not be tab-reachable")
          .not.toContain(profile.decoyField!.elementId);
      }

      // 5. Decoy input: ZERO painted area in both renderers.
      for (const facts of [worker, host]) {
        const decoy = facts.inputFootprints.find((f) => f.name === profile.decoyField!.fieldName);
        expect(decoy, "decoy input present in DOM").toBeDefined();
        expect(decoy!.paintedAreaPx, "decoy paints nothing").toBe(0);
      }
    }, 30_000);
  }

  it("plain decoy input (no semantic): zero footprint on both renderers", async () => {
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: "parity-decoy-only", mode: "production" },
      ABLATION_RECIPES.PRODUCTION_FIELD
    );
    expect(profile.decoyField).toBeDefined();
    const { worker, host } = await renderBoth(profile);
    for (const facts of [worker, host]) {
      const decoy = facts.inputFootprints.find((f) => f.name === profile.decoyField!.fieldName);
      expect(decoy).toBeDefined();
      expect(decoy!.paintedAreaPx).toBe(0);
    }
    expect(host.visibleText).toBe(worker.visibleText);
  }, 30_000);

  // ── Rereview item 30: CROSS-SESSION visual invariance. ────────────────────
  // Randomization varies the MACHINE plane only. Across DIFFERENT random
  // production draws — different strategies, wordings, spot anchors, field
  // names, route tokens — the HUMAN-facing page must be pixel-stable:
  // identical visible text, identical form geometry, no trap tab stops, no
  // AX exposure. (Per-renderer parity above pins renderer A == renderer B
  // for one profile; THIS pins profile A ≡ profile B for the human.)
  it("cross-session invariance: 5 random draws → identical human page (text, geometry, tab, AX)", async () => {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    const facts: PageFacts[] = [];
    for (let i = 0; i < 5; i++) {
      const profile = await deriveProfilePure(
        { secret: SECRET, version: 1, sessionId: `visual-invariance-${i}`, mode: "production" }
      );
      expect(profile.semantic, "production always carries a semantic strategy").toBeDefined();
      const html = renderSignupPage({
        html: BASE_HTML, profile, csrfToken: "csrf-x", evaluationMode: false,
      });
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "load" });
      facts.push(await measure(page));
      await page.close();
    }

    // 1. Every human-visible page reads IDENTICALLY.
    for (let i = 1; i < facts.length; i++) {
      expect(facts[i].visibleText, `session ${i} visible text`).toBe(facts[0].visibleText);
    }
    // 2. The form occupies the same box in every draw (no reflow drift).
    for (let i = 1; i < facts.length; i++) {
      expect(Math.abs(facts[i].formBox!.width - facts[0].formBox!.width), `session ${i} width`).toBeLessThanOrEqual(2);
      expect(Math.abs(facts[i].formBox!.height - facts[0].formBox!.height), `session ${i} height`).toBeLessThanOrEqual(2);
    }
    // 3. AX exposure identical and free of trap material in every draw.
    const ax = (f: PageFacts) => f.axNames.join("|");
    for (let i = 1; i < facts.length; i++) {
      expect(ax(facts[i]), `session ${i} AX`).toBe(ax(facts[0]));
    }
    // 4. Tab order identical, and never reaches a decoy field.
    for (let i = 1; i < facts.length; i++) {
      expect(facts[i].tabOrder, `session ${i} tab`).toEqual(facts[0].tabOrder);
    }
    // 5. Every drawn decoy field (each session has its own name) paints
    //    NOTHING and is absent from that session's tab order + AX names.
    for (let i = 0; i < facts.length; i++) {
      const profile = await deriveProfilePure(
        { secret: SECRET, version: 1, sessionId: `visual-invariance-${i}`, mode: "production" }
      );
      const decoy = facts[i].inputFootprints.find((f) => f.name === profile.decoyField?.fieldName);
      if (profile.decoyField) {
        expect(decoy, `session ${i} decoy present`).toBeDefined();
        expect(decoy!.paintedAreaPx, `session ${i} decoy paints nothing`).toBe(0);
        expect(facts[i].tabOrder).not.toContain(profile.decoyField.fieldName);
      }
    }
  }, 60_000);
});
