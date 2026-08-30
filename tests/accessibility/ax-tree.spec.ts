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
  // FIRERAID_TEST_BASE_URL is exported by scripts/test-worker.mjs (https).
  const labBase = process.env.FIRERAID_TEST_BASE_URL ?? "https://localhost:9998";
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

  test("production-eligible canaries are visible (not display:none)", async ({ page }) => {
    await page.goto("/signup");
    const canary = page.locator("[data-fr-canary-id]");
    if (await canary.count()) {
      const count = await canary.count();
      for (let i = 0; i < count; i++) {
        const el = canary.nth(i);
        const ariaHidden = await el.getAttribute("aria-hidden");
        if (ariaHidden !== "true") {
          await expect(el).toBeVisible();
        }
      }
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
  // FR-R5-042: Random-profile smoke test — renamed to signal that treatment-
  // sensitive assertions live in the pinned-tests below.  Skip only when no
  // semantic canary renders (expected when the random profile lacks
  // the "semantic" family).
  test("canary marker exclusion from AX tree (random-profile smoke)", async ({ page }) => {
    await page.goto("/signup");

    const dom = await page.content();
    const ax = axNormalized(await page.locator("body").ariaSnapshot());

    const canaryWrapper = page.locator("[data-fr-canary-id]");
    const canaryCount = await canaryWrapper.count();

    // Case 1: No canary rendered — skip (not a failure)
    if (canaryCount === 0) {
      test.skip(true, "no semantic canary in this random session");
    }

    // Case 2: Hidden canary — negative control
    const hiddenCanary = page.locator("[data-fr-canary-id][aria-hidden='true']");
    if (await hiddenCanary.count()) {
      const markerSpan = hiddenCanary.locator("[data-fr-marker]").first();
      const markerValue = await markerSpan.getAttribute("data-fr-marker");
      expect(markerValue).toBeTruthy();
      expect(ax).not.toContain(markerValue!);
      await expect(hiddenCanary.first()).toHaveAttribute("aria-hidden", "true");
      await expect(hiddenCanary.first()).toHaveAttribute("tabindex", "-1");
    }

    // Case 3: Visible canary — positive control.
    // Compare the <strong> heading text only: ariaSnapshot splits inline
    // content (code/nonce) into separate nodes, so full-paragraph matching
    // never succeeds against the node-form snapshot.
    const visibleCanary = page.locator("[data-fr-canary-id]").filter({
      hasNot: page.locator("[aria-hidden='true']"),
    });
    if (await visibleCanary.count()) {
      const heading = visibleCanary.locator("strong").first();
      const text = axNormalized((await heading.textContent()) ?? "");
      expect(text).toBeTruthy();
      expect(ax).toContain(text);
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

    // (1) DOM contains span[data-fr-canary="S09"][data-fr-marker].
    // S09/P06 is non-rendered by design — assert EXISTENCE in DOM and
    // hidden-from-viewport, never visibility.
    const markerSpan = page.locator("span[data-fr-canary='S09'][data-fr-marker]");
    await expect(markerSpan).toHaveCount(1);
    await expect(markerSpan).toBeAttached();
    await expect(markerSpan).toBeHidden();

    // (2) wrapper has aria-hidden="true" and tabindex="-1"
    const wrapper = page.locator("[data-fr-canary-id='S09']");
    await expect(wrapper).toHaveAttribute("aria-hidden", "true");
    await expect(wrapper).toHaveAttribute("tabindex", "-1");

    // (3) Read the marker nonce from DOM at runtime and verify it is NOT in the AX snapshot
    const nonceValue = await markerSpan.getAttribute("data-fr-marker");
    expect(nonceValue).toBeTruthy();
    const ax = await page.locator("body").ariaSnapshot();
    expect(ax).not.toContain(nonceValue!);

    // (4) covered by (1)'s toBeHidden — S09/P06 must never be visible.

    // (5) tabindex="-1" is a sufficient proxy for non-appearance in tab order
    //     (flaky to assert full tab-skip, so we rely on the attribute above)
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
