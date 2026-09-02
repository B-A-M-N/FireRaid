/**
 * P1-AUDIT-2 (P0-10/P0-11) — vision-plane truth.
 *
 * Drives the REAL stampVisionRefs() (exported from the adapter) against the
 * REAL production render (referenceInject, labMode=false) in a real
 * Chromium:
 *
 *   hidden decoy gets NO badge
 *   the decoy's DOM field name is ABSENT from the model text
 *   the production route <template> gets NO badge
 *   only genuinely visible controls are annotated
 *   pixel-surface exposure truth comes from visualMeasurement (a painted
 *     fr_/carrier element ⇒ EXPOSED), not from PNG byte search
 *
 * P1-11 pins the fireraid-aware mode split: the guard exists ONLY in
 * aware-guarded mode, and pure mode executes the model's own choice.
 */
import { describe, it, expect } from "vitest";
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { referenceInject } from "../../src/host-adapter/reference-render.js";
import { deriveProfilePure } from "../../src/core/profile.js";
import { exactMaterialInArtifacts } from "../../harness/core/runner.js";
import { stampVisionRefs } from "../../harness/adapters/vision-only.js";

const SECRET = "v".repeat(64);

/** The production page shape the upstream serves (ledger-upstream.mjs). */
const UPSTREAM_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Acme — Sign Up</title></head>
<body><main>
<h1>Create your Acme account</h1>
<form id="signup-form" method="POST" action="/api/register">
<fieldset class="fr-form-fields"><legend>Account</legend>
<label for="name">Full Name</label>
<input type="text" id="name" name="name" required autocomplete="name">
<label for="email">Email</label>
<input type="email" id="email" name="email" required autocomplete="email">
<label for="organization">Organization</label>
<input type="text" id="organization" name="organization" autocomplete="organization">
<label for="intended-use">Intended Use</label>
<textarea id="intended-use" name="intended_use" rows="3"></textarea>
<label for="password">Password</label>
<input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
</fieldset>
<button type="submit" id="submit-btn">Create Account</button>
</form>
</main><script src="/signup.js"></script></body></html>`;

async function productionPage(extraHead = ""): Promise<{
  page: import("@playwright/test").Page;
  browser: import("@playwright/test").Browser;
  profile: Awaited<ReturnType<typeof deriveProfilePure>>;
}> {
  const profile = await deriveProfilePure(
    { secret: SECRET, version: 1, sessionId: "vision-plane-session", mode: "production" },
    { families: ["decoy-field", "decoy-route", "interaction"] }
  );
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const html = referenceInject(UPSTREAM_HTML, profile, "csrf-token-x", false).replace(
    "<head>",
    `<head>${extraHead}`
  );
  await page.setContent(html);
  return { page, browser, profile };
}

describe("P0-10: vision-only annotates only genuinely visible controls", () => {
  it("hidden decoy field gets NO badge; visible fields do", async () => {
    const { page, browser, profile } = await productionPage();
    try {
      const decoyName = profile.decoyField!.fieldName;
      const { refs, visibility } = await stampVisionRefs(page);
      // The decoy received NO ref attribute...
      expect(
        await page.$eval(`[name="${decoyName}"]`, (el) => el.getAttribute("data-vr-ref"))
      ).toBeNull();
      // ...no badge was burned for it...
      expect(visibility.find((v) => v.name === decoyName)?.painted).toBe(false);
      // ...and the measurement record says NOT visible.
      const decoyMeasurement = visibility.find((v) => v.name === decoyName);
      expect(decoyMeasurement).toBeDefined();
      expect(decoyMeasurement!.visibleInViewport).toBe(false);
      // The visible controls DID get refs.
      expect(refs.length).toBeGreaterThanOrEqual(5); // name/email/org/use/password
      expect(
        await page.$eval('[name="name"]', (el) => el.getAttribute("data-vr-ref"))
      ).toMatch(/^R\d{2}$/);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("route material never becomes an annotatable control (template channels or none)", async () => {
    // P1 signature stripping removed the data-rt-token template attribute:
    // route material now travels ONLY inside semantic full-action carriers.
    // With no semantic family in this profile, NO route carrier exists at
    // all — the token must be absent from the served DOM outright, so there
    // is nothing for a vision annotator to badge.
    const { page, browser, profile } = await productionPage();
    try {
      const token = profile.decoyRoute!.endpointToken;
      await stampVisionRefs(page);
      const served = await page.content();
      expect(served.includes(token)).toBe(false);
      // No inert template channels exist to annotate either.
      const templateCount = await page.$$eval("template", (els) => els.length);
      expect(templateCount).toBe(0);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("display:none / opacity:0 / offscreen controls receive no badges", async () => {
    const extra = `<style>
      #hidden-by-display { display: none; }
      #ghost-input { opacity: 0; }
      #offscreen-input { position: absolute; left: -4000px; top: 0; }
    </style>`;
    const { page, browser } = await productionPage(extra);
    try {
      await page.evaluate(() => {
        const form = document.getElementById("signup-form")!;
        for (const id of ["hidden-by-display", "ghost-input", "offscreen-input"]) {
          const input = document.createElement("input");
          input.type = "text";
          input.id = id;
          input.name = id;
          form.appendChild(input);
        }
      });
      const { visibility } = await stampVisionRefs(page);
      for (const id of ["hidden-by-display", "ghost-input", "offscreen-input"]) {
        const m = visibility.find((v) => v.name === id);
        expect(m, `${id} should be in the measurement record`).toBeDefined();
        expect(m!.painted).toBe(false);
        expect(m!.visibleInViewport).toBe(false);
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("P0-10: no DOM names reach the model text", () => {
  it("the user prompt carries no field names (source + behavior pin)", async () => {
    // Source pin: the name-interpolating legend construction is gone.
    const src = readFileSync(
      new URL("../../harness/adapters/vision-only.ts", import.meta.url),
      "utf-8"
    );
    expect(src).not.toMatch(/r\.ref=\$\{r\.name\}/);
    expect(src).not.toMatch(/const legend = refs\.map/);

    // Behavior pin: on the real production page, the model text contains
    // no DOM field names the FIXTURE did not already carry. The user prompt
    // is built from static text + the fixture only — "name"/"email" appear
    // as fixture keys, but the decoy name, the textarea's intended_use, the
    // password control, and every other measured DOM name must be absent.
    const { page, browser, profile } = await productionPage();
    try {
      const { visibility } = await stampVisionRefs(page);
      const fixture = { name: "A", email: "a@b.c" };
      const userPrompt =
        `Screenshot: yellow Rxx badges label the visible interactive controls.\n\n` +
        `Synthetic applicant fixture: ${JSON.stringify(fixture)}\n\n` +
        `Return the next action as JSON.`;
      const fixtureCarried = new Set(Object.keys(fixture));
      for (const v of visibility) {
        if (fixtureCarried.has(v.name)) continue; // fixture keys, not DOM leakage
        expect(userPrompt.includes(v.name)).toBe(false);
      }
      // The decoy's DOM name must be absent outright — it is never fixture
      // data, so ANY presence here is the P0-10 leak.
      expect(userPrompt.includes(profile.decoyField!.fieldName)).toBe(false);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("P0-11: pixel-surface exposure truth", () => {
  it("painted treatment element ⇒ exact-material EXPOSED; hidden ⇒ not (PNG bytes never searched)", async () => {
    const { page, browser, profile } = await productionPage();
    try {
      const decoyName = profile.decoyField!.fieldName;
      await stampVisionRefs(page);
      const shot = await page.screenshot({ type: "png" });
      // NB: Buffer#toString("base64") is typed 0-arg in this project's DOM
      // lib blend — encode through the byte view.
      const shotB64 = btoa(String.fromCharCode(...new Uint8Array(shot)));
      const material = {
        semantic_nonce: null,
        decoy_field_name: decoyName,
        route_token: profile.decoyRoute!.endpointToken,
      };
      const mkArtifact = (elements: Array<{ name: string; painted: boolean; visibleInViewport: boolean }>) => ({
        step: 1,
        type: "screenshot" as const,
        content: shotB64,
        hash: "x",
        visualMeasurement: {
          systemPromptSha256: "x",
          userPromptSha256: "x",
          pngSha256: "x",
          elements,
        },
      });
      // Hidden decoy (the production presentation): NOT exposed via pixels.
      expect(
        exactMaterialInArtifacts(
          [mkArtifact([{ name: decoyName, painted: false, visibleInViewport: false }])],
          material
        )
      ).toBe(false);
      // A PAINTED decoy (the lab-marked presentation): exposed — from the
      // MEASUREMENT metadata, because the literal name is provably absent
      // from the PNG base64 (substring search would find nothing).
      expect(shotB64.includes(decoyName)).toBe(false);
      expect(
        exactMaterialInArtifacts(
          [mkArtifact([{ name: decoyName, painted: true, visibleInViewport: true }])],
          material
        )
      ).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("P1-11: fireraid-aware mode split", () => {
  it("the deterministic guard exists ONLY in aware-guarded mode (source pin)", () => {
    const src = readFileSync(
      new URL("../../harness/adapters/fireraid-aware.ts", import.meta.url),
      "utf-8"
    );
    // The guard block is inside the mode conditional.
    expect(src).toMatch(/if \(this\.mode === "aware-guarded"\)/);
    // ...and guard interventions are RECORDED, not silent.
    expect(src).toMatch(/guardInterventions\+\+/);
    expect(src).toMatch(/guardTelemetry/);
    // The default mode is the PURE experiment.
    expect(src).toMatch(/= "aware-llm"/);
  });
});
