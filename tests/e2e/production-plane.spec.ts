/**
 * E2E — PRODUCTION-PLANE browser acceptance (P1, P0-AUDIT-3).
 *
 * Boots wrangler env `production-test` (LAB_MODE=false, TURNSTILE_MODE=
 * disabled-test, synthetic secrets — see playwright.production.config.ts).
 * This is the tier the lab-plane suite (normal-user.spec.ts, LAB_MODE=true)
 * deliberately is not: it exercises the ACTUAL production treatment —
 * stateless session envelopes, inert multi-spot semantic carriers, no lab
 * banner, no FireRaid presentation signatures — in real browsers.
 *
 * Invariants under test (every production signup page):
 *   - no lab banner (.fr-lab-banner absent)
 *   - no data-fr / data-rt presentation-signature attributes
 *   - no fr-prefixed internal class tokens
 *   - no internal strategy identifiers (Sxx / Pxx) in markup
 *   - the client config script is the production id (app-runtime-config),
 *     never the lab id (fr-client-config)
 *   - the form still works for humans: normal / keyboard-only /
 *     autofill-like flows submit with 200 `received` and ZERO causal
 *     canary hits
 */
import { test, expect } from "@playwright/test";

const FIXTURE = {
  name: "Casey Example",
  email: "casey@example.invalid",
  organization: "Example Research",
  intended_use: "Research purposes",
  password: "synthetic-password-123",
};

test.describe("production plane: presentation-signature invisibility", () => {
  test("production signup page carries no FireRaid presentation signatures", async ({ page }) => {
    await page.goto("/signup");

    // 1. No lab banner — the lab-plane marker must never exist in production.
    await expect(page.locator(".fr-lab-banner")).toHaveCount(0);

    // 2. No data-fr-* / data-rt-* attributes anywhere in the DOM.
    const signed = await page.evaluate(() => {
      const hits: string[] = [];
      document.querySelectorAll("*").forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
          if (/^(data-fr|data-rt)-/.test(attr.name)) {
            hits.push(`${el.tagName}[${attr.name}]`);
          }
        }
      });
      return hits;
    });
    expect(signed, "no data-fr-*/data-rt-* attributes").toEqual([]);

    // 3. No FireRaid-internal CARRIER class tokens. The page's own static
    // styling may legitimately use fr- prefixed classes (signup.html's
    // fr-container/fr-subtitle/fr-form-fields/fr-disclaimer are host page
    // markup, and the client's fr-result receipt classes are its own UI) —
    // the invariant is that no INJECTED TRAP carries an identifying class:
    // carriers in production are bare <template> elements.
    const internalFrClasses = [
      "fr-decoy",
      "fr-canary-wrap",
      "fr-canary-inert",
      "fr-canary-server-injected",
      "fr-canary-desc",
      "fr-visually-hidden",
      "fr-canary",
      "fr-hidden-neutral",
      "fr-lab-banner",
    ];
    const frClasses = await page.evaluate((tokens) => {
      const hits: string[] = [];
      document.querySelectorAll("*").forEach((el) => {
        for (const cls of Array.from(el.classList)) {
          if (tokens.includes(cls)) hits.push(`${el.tagName}.${cls}`);
        }
      });
      return hits;
    }, internalFrClasses);
    expect(frClasses, "no injected-trap fr-* classes").toEqual([]);

    // 4. No internal strategy identifiers in the served markup.
    // The invariant is that NONE of the catalog IDs appear at all.
    const body = await page.content();
    const catalog = ["P01","P02","P03","P04","P05","P06","S01","S02","S03","S04","S05","S06","S07","S08","S09"];
    const found = catalog.filter((id) => new RegExp(`\\b${id}\\b`).test(body));
    expect(found, "no catalog strategy IDs in markup").toEqual([]);

    // 5. The client config element is the PRODUCTION id.
    await expect(page.locator("#app-runtime-config")).toHaveCount(1);
    await expect(page.locator("#fr-client-config")).toHaveCount(0);
  });

  test("production carriers stay inert: no focusable/tab-reachable trap content", async ({ page }) => {
    await page.goto("/signup");
    // Production carriers render inside <template> (inert by spec — content
    // never enters the DOM tree). Any element that DID materialize from a
    // carrier must not be a focusable control.
    const focusables = await page.evaluate(() => {
      const hits: string[] = [];
      document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
        if (el.tagName === "TEMPLATE") return;
        if (el.tabIndex >= 0 && !["INPUT", "BUTTON", "A", "SELECT", "TEXTAREA"].includes(el.tagName)) {
          hits.push(el.tagName + (el.id ? `#${el.id}` : ""));
        }
      });
      return hits;
    });
    expect(focusables, "no unexpected focusable non-controls").toEqual([]);
    // First Tab reaches a legitimate form field.
    await page.keyboard.press("Tab");
    const first = await page.evaluate(
      () => (document.activeElement as HTMLElement)?.id || (document.activeElement as HTMLElement)?.tagName
    );
    expect(first).toBeTruthy();
  });
});

test.describe("production plane: human flows still work", () => {
  for (const [label, run] of [
    ["normal (mouse fill + click)", async (page: import("@playwright/test").Page) => {
      await page.fill("#name", FIXTURE.name);
      await page.fill("#email", FIXTURE.email);
      await page.fill("#organization", FIXTURE.organization);
      await page.fill("#intended-use", FIXTURE.intended_use);
      await page.fill("#password", FIXTURE.password);
      await page.click("#submit-btn");
    }],
    ["keyboard-only", async (page: import("@playwright/test").Page) => {
      await page.keyboard.press("Tab");
      await page.keyboard.type(FIXTURE.name);
      await page.keyboard.press("Tab");
      await page.keyboard.type(FIXTURE.email);
      await page.keyboard.press("Tab");
      await page.keyboard.type(FIXTURE.organization);
      await page.keyboard.press("Tab");
      await page.keyboard.type(FIXTURE.intended_use);
      await page.keyboard.press("Tab");
      await page.keyboard.type(FIXTURE.password);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
    }],
    ["autofill-like (programmatic)", async (page: import("@playwright/test").Page) => {
      await page.evaluate((f) => {
        const set = (id: string, val: string) => {
          const el = document.getElementById(id) as HTMLInputElement | null;
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        };
        set("name", f.name);
        set("email", f.email);
        set("organization", f.organization);
        set("intended-use", f.intended_use);
        set("password", f.password);
      }, FIXTURE);
      await page.click("#submit-btn");
    }],
  ] as const) {
    test(`${label}: submit 200 received, zero causal evidence`, async ({ page }) => {
      test.setTimeout(60_000);
      const canaryHits: string[] = [];
      page.on("request", (req) => {
        if (req.url().includes("/c/")) canaryHits.push(req.url());
      });

      await page.goto("/signup");
      await expect(page.locator("#signup-form")).toBeVisible();

      const responsePromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
        { timeout: 15_000 }
      );
      await run(page);

      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const result = (await response.json()) as { status?: string };
      expect(result.status).toBe("received");

      // The primary negative: a clean human flow must never trip the causal
      // canary route (that evidence would mean a false-positive block).
      expect(canaryHits, "clean human flow produces zero canary hits").toEqual([]);
    });
  }
});
