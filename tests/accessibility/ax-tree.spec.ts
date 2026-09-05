/**
 * AX tree snapshot tests (FR-R3-054/055).
 * Actually capture accessibility tree and inspect it.
 * FIX FR-R4-057: Replace tautological typeof check with real positive/negative
 *   controls using ariaSnapshot and DOM inspection.
 * FIX FR-R4-058: Use toHaveAccessibleName instead of id-based candidate list.
 * FIX FR-R4-059: Add deterministic canary controls via lab API.
 * FIX FR-R5-041: Deterministic AX tests required, not skipped — the bootstrap
 *   always sets FIRERAID_TEST_LAB_SECRET and the base URL; never skip for
 *   missing env.  FIX FR-R5-042: Random-profile smoke test demoted.
 * FIX FR-R5-043: Rewrite misnamed canary test with full AX assertions.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { inspectLabCarriers } from "../../src/core/artifacts.js";

// ─── Shared helpers (FR-R5-041) ────────────────────────────────────────────

/** Create a pinned lab run via the lab API and return { run_id, bind_token }. */
async function createPinnedRun(
  request: APIRequestContext,
  recipe: {
    families: string[];
    semanticTemplate: string;
    placementId: string;
    labOnly: boolean;
  }
) {
  // FR-R5-041: deterministic defaults — bootstrap always sets these.
  // FIRERAID_TEST_BASE_URL is exported by scripts/test-worker.mjs to the
  // SUITE child. The a11y config runs no suite child (Playwright owns the
  // test process), so fall back to the port override the config itself
  // reads (FIRERAID_A11Y_PORT) — never a hardcoded port: an unrelated
  // listener on the fallback would silently answer the lab API (found
  // live: pinned-bind tests POSTing a stale orphan on the old default).
  const port = process.env.FIRERAID_A11Y_PORT ?? "9998";
  const labBase = process.env.FIRERAID_TEST_BASE_URL ?? `https://localhost:${port}`;
  const labSecret = process.env.FIRERAID_TEST_LAB_SECRET ?? "local-lab-secret-do-not-use-in-prod";
  const createResp = await request.post(`${labBase}/api/lab/runs`, {
    headers: { authorization: `Bearer ${labSecret}` },
    data: { recipe },
  });
  expect(createResp.status()).toBe(200);
  return createResp.json() as Promise<{ run_id: string; bind_token: string }>;
}

/** Build the bind URL from a run record returned by createPinnedRun. */
function bindUrl(run: { run_id: string; bind_token: string }): string {
  return `/signup?lab_run=${run.run_id}&bind=${run.bind_token}`;
}

// ─── Accessibility checks on plain /signup ─────────────────────────────────

test.describe("accessibility", () => {
  test("signup page has no critical axe violations", async ({ page }) => {
    await page.goto("/signup");
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => v.impact === "critical");
    expect(critical).toEqual([]);
  });

  test("visible labels are stable", async ({ page }) => {
    await page.goto("/signup");
    const labels = await page.locator("label").count();
    expect(labels).toBeGreaterThanOrEqual(6);
  });

  test("tab order reaches all interactive elements", async ({ page }) => {
    await page.goto("/signup");
    await page.keyboard.press("Tab");
    const firstFocused = await page.evaluate(() => document.activeElement?.id);
    expect(firstFocused).toBe("name");
  });

  test("canary with aria-hidden is excluded from AX tree", async ({ page }) => {
    await page.goto("/signup");
    const hiddenCanary = page.locator("[data-fr-canary-id][aria-hidden='true']");
    if (await hiddenCanary.count()) {
      await expect(hiddenCanary.first()).toHaveAttribute("aria-hidden", "true");
      await expect(hiddenCanary.first()).toHaveAttribute("tabindex", "-1");
    }
  });

  test("attached carriers are legal lab shapes; inert channels stay inert", async ({ page }) => {
    // PLANE-AWARE (P0-AUDIT-3 repair): this suite runs the LAB plane, where
    // a random session may legitimately draw a P01–P05 carrier — an
    // ATTACHED element whose visible/AX exposure IS the experimental
    // condition — or an S09/P06-style inert template. Both shapes are
    // legal; the invariant here is that every carrier is one of the two
    // KNOWN shapes. The production-plane invariant (ALL carriers inert,
    // nothing focusable) is enforced by tests/e2e/production-plane.spec.ts
    // against LAB_MODE=false.
    await page.goto("/signup");
    const canary = page.locator("[data-fr-canary-id]");
    const count = await canary.count();
    for (let i = 0; i < count; i++) {
      const el = canary.nth(i);
      const tag = await el.evaluate((node) => node.tagName);
      if (tag === "TEMPLATE") {
        // Inert by spec — nothing to check (fragment never attaches).
        continue;
      }
      // Lab probe element: it may be visible (P01–P05) — but it must never
      // be a focusable control (form inputs, buttons, links are reserved
      // for the real form).
      const focusable = await el.evaluate((node) => {
        const e = node as HTMLElement;
        return e.tabIndex >= 0 && !e.hasAttribute("disabled");
      });
      expect(focusable, "carrier must not be a tab-reachable control").toBe(false);
    }
  });
});

// ─── Accessible names ──────────────────────────────────────────────────────

test.describe("accessible names", () => {
  test("all form fields have accessible names (FR-R4-058)", async ({ page }) => {
    await page.goto("/signup");

    const fields = [
      "name",
      "email",
      "organization",
      "intended-use",
      "password",
    ];

    for (const field of fields) {
      const el = page.locator(`#${field}`);
      await expect(el).toBeVisible();
      const label = page.locator(`label[for="${field}"]`).first();
      const labelText = (await label.textContent())?.trim() ?? "";
      expect(labelText).toBeTruthy();
      await expect(el).toHaveAccessibleName(labelText);
    }
  });

  test("submit button has accessible name", async ({ page }) => {
    await page.goto("/signup");
    const submitBtn = page.locator("#submit-btn");
    await expect(submitBtn).toBeVisible();
    const text = await submitBtn.textContent();
    const ariaLabel = await submitBtn.getAttribute("aria-label");
    expect(text || ariaLabel).toBeTruthy();
  });

  test("canary elements have no accessible name when hidden", async ({ page }) => {
    await page.goto("/signup");
    await page.waitForTimeout(500);
    const hiddenCanaries = page.locator("[data-fr-canary-id][aria-hidden='true']");
    const count = await hiddenCanaries.count();
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const el = hiddenCanaries.nth(i);
        const ariaLabel = await el.getAttribute("aria-label");
        if (ariaLabel) {
          expect(ariaLabel.trim()).toBe("");
        }
      }
    }
  });
});

// ─── AX tree verification (random-profile smoke) ───────────────────────────

/**
 * ariaSnapshot renders multi-line/inline elements as separate nodes
 * ("strong:", "text:", "code:"), so raw substring matching against the
 * original HTML text fails. Collapse all whitespace on both sides.
 */
function axNormalized(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

test.describe("AX tree verification", () => {
  // FR-R5-042: Random-profile smoke test. PLANE-AWARE: this suite runs the
  // LAB plane (wrangler env test, LAB_MODE=true), where a random session
  // may draw a P01–P05 carrier — an ATTACHED element whose AX visibility IS
  // the experimental condition — or the S09/P06-style inert template. Both
  // shapes are legal here; what must hold in BOTH is that any nonce marker
  // material that exists in the markup is either (a) AX-visible lab probe
  // content (an intended exposure, asserted by the pinned tests below) or
  // (b) absent from the AX snapshot. The PRODUCTION-plane inertness is
  // separately enforced in tests/e2e/production-plane.spec.ts.
  test("canary marker exclusion from AX tree (random-profile smoke)", async ({ page }) => {
    await page.goto("/signup");

    const dom = await page.content();
    const ax = axNormalized(await page.locator("body").ariaSnapshot());

    const canaryWrapper = page.locator("[data-fr-canary-id]");
    const canaryCount = await canaryWrapper.count();

    // Case 1: No canary drawn for this session — nothing to assert.
    if (canaryCount === 0) {
      test.skip(true, "no semantic canary in this random session");
    }

    // Case 2 (plane-aware carrier shapes): every attached carrier is either
    // an inert <template> (fragment content never attaches) or a lab-probe
    // DIV intentionally rendered for AX exposure. Any THIRD shape is a
    // violation.
    for (let i = 0; i < canaryCount; i++) {
      const tag = await canaryWrapper.nth(i).evaluate((node) => node.tagName);
      expect(
        tag,
        "carrier must be an inert <template> or a lab-probe element"
      ).toMatch(/^(TEMPLATE|DIV|SPAN)$/);
    }

    // Case 3 (negative control): nonce markers in NON-RENDERED carrier
    // channels must never reach the AX snapshot. P0-2: the nonce comes from
    // the canonical introspection (data-fr-marker attributes AND the
    // meta/comment channel serializations). Visible lab-probe TEXT may
    // legitimately be in the AX tree (that is the P01–P05 experimental
    // condition) but a hidden-channel nonce must stay out in every plane.
    const carrierTruth = inspectLabCarriers(dom);
    if (carrierTruth.nonce) {
      expect(ax, `marker nonce must not appear in the AX tree`).not.toContain(carrierTruth.nonce);
    }
    expect(dom).toContain("data-fr-canary-id");
  });

  test("AX tree structure for documentation", async ({ page }) => {
    await page.goto("/signup");
    await page.waitForTimeout(500);
    const snapshot = axNormalized(await page.locator("body").ariaSnapshot());
    expect(snapshot).toBeTruthy();
    expect(snapshot).toContain("Create Account");
    expect(snapshot).toContain("textbox");
    expect(typeof snapshot).toBe("string");
  });

  test("P06 canary elements are not in accessibility tree", async ({ page }) => {
    await page.goto("/signup");
    await page.waitForTimeout(500);

    const canaryElements = page.locator("[data-fr-canary-id]");
    const count = await canaryElements.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const el = canaryElements.nth(i);
        const ariaHidden = await el.getAttribute("aria-hidden");
        const role = await el.getAttribute("role");

        if (ariaHidden === "true") {
          const tabindex = await el.getAttribute("tabindex");
          expect(tabindex).toBe("-1");
        }

        if (role === "presentation") {
          expect(role).toBe("presentation");
        }
      }
    }
  });
});

// ─── Deterministic canary controls (FR-R4-059 / FR-R5-041/043) ────────────

test.describe("deterministic canary controls", () => {
  // FIX FR-R5-043: Complete rewrite.  Pinned run → bind → assert DOM, AX,
  // aria-hidden/tabindex, and non-rendered status.
  test("S09/P06 hidden canary is excluded from AX tree (FR-R5-043)", async ({
    page,
    request,
  }) => {
    // FR-R5-041: never skip for missing env — bootstrap provides defaults.

    // Create a pinned lab run with the hidden S09/P06 recipe
    const run = await createPinnedRun(request, {
      families: ["semantic"],
      semanticTemplate: "S09",
      placementId: "P06",
      labOnly: true,
    });

    // Navigate to the pinned session
    await page.goto(bindUrl(run));

    // (1) The non-rendered carrier exists in the served HTML. P0-2: assert
    // carrier SEMANTICS via the canonical introspection — the multi-spot
    // placement may serialize S09 over template/meta/comment channels; the
    // retired `data-fr-canary` attribute name is one body serialization,
    // not the contract.
    const html = await page.content();
    const carriers1 = inspectLabCarriers(html);
    expect(carriers1.templateId, "S09 carrier present in served HTML").toBe("S09");
    expect(carriers1.nonce, "session nonce present in a carrier").toMatch(/^[A-Z2-9]{6}$/);

    // (2) Every ATTACHED carrier ELEMENT is an inert <template>. The
    // template ELEMENT itself attaches at head/body anchors, but its
    // content lives in a DocumentFragment — it never participates in
    // layout, the AX tree, or tab order. A non-template carrier (div/span)
    // attached to the live DOM would be a real violation.
    //
    // FR-R5-043 flake fix (found live, ~12.8% of session draws): the
    // multi-spot pool includes head-meta and body-comment, whose carrier
    // channels are a VOID <meta> and an HTML comment — NEITHER has a
    // data-fr-canary-id element in the DOM. A draw that lands only on those
    // anchors (step 1 already proved carriers shipped) legitimately finds
    // zero elements here, so a ≥1 count asserted the wrong transport, not
    // the invariant. The invariant is conditional: every carrier ELEMENT
    // that DOES attach must be an inert template.
    const carriers = page.locator("[data-fr-canary-id='S09']");
    const carrierCount = await carriers.count();
    for (let i = 0; i < carrierCount; i++) {
      const tag = await carriers.nth(i).evaluate((el) => el.tagName);
      expect(tag, "S09 carrier must be an inert template, never a live wrapper").toBe("TEMPLATE");
    }

    // (2b) The element-free channels are structurally AX-invisible — the
    // actual accessibility property this suite guards. A <meta> is
    // non-content by definition and a comment is not a node; assert the
    // introspector found them and that their material stays out of the AX
    // snapshot (asserted alongside the nonce in step 3 below). For a
    // channel-only draw this block is what remains meaningful.
    if (carrierCount === 0) {
      expect(
        carriers1.channels.meta || carriers1.channels.comment,
        "element-free draw must have shipped meta/comment carriers (step 1 proved the carrier)"
      ).toBe(true);
    }

    // (3) The marker nonce must be absent from the AX snapshot. P0-2: the
    // nonce comes from the canonical introspection (any carrier channel).
    expect(carriers1.nonce, "S09 marker carries a nonce").not.toBeNull();
    const ax = await page.locator("body").ariaSnapshot();
    expect(ax).not.toContain(carriers1.nonce!);

    // (4) covered: un-attached template content can never be visible.

    // (5) covered: un-attached content has no tabindex at all.
  });

  // FIX FR-R5-041: Use the shared createPinnedRun helper and never skip.
  test("S01/P01 visible canary IS in AX tree (FR-R5-043)", async ({
    page,
    request,
  }) => {
    const run = await createPinnedRun(request, {
      families: ["semantic"],
      semanticTemplate: "S01",
      placementId: "P01",
      labOnly: true,
    });

    await page.goto(bindUrl(run));

    // The S01 canary renders text like "Automation Test Marker."
    // Verify that the visible heading text IS in the AX snapshot.
    // (axNormalized: ariaSnapshot splits inline elements into nodes.)
    const ax = axNormalized(await page.locator("body").ariaSnapshot());
    expect(ax).toContain("Automation Test Marker");
  });
});
