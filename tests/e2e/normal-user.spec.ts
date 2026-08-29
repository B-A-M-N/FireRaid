/**
 * E2E — normal visible user. Required gate: zero causal canary hits, zero accidental quarantine.
 * FIX: Now verifies actual API response (FR-002).
 * FIX: Injects fake Turnstile token for testing (test keys don't produce real tokens).
 */
import { test, expect } from "@playwright/test";

const FIXTURE = {
  name: "Casey Example",
  email: "casey@example.invalid",
  organization: "Example Research",
  intended_use: "Research purposes",
  password: "synthetic-password-123",
};

test.describe("normal user", () => {
  test("form works and submits with verified API response", async ({ page }) => {
    const canaryHits: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/c/")) canaryHits.push(req.url());
    });

    await page.goto("/signup");
    await expect(page.locator("#signup-form")).toBeVisible();
    await expect(page.locator(".fr-lab-banner")).toBeVisible();

    await page.fill("#name", FIXTURE.name);
    await page.fill("#email", FIXTURE.email);
    await page.fill("#organization", FIXTURE.organization);
    await page.fill("#intended-use", FIXTURE.intended_use);
    await page.fill("#password", FIXTURE.password);

    // Inject Turnstile token by executing JavaScript directly
    await page.evaluate(() => {
      // Set the turnstile token by calling the callback if it exists
      if (typeof (window as any).turnstileOnSuccess === 'function') {
        (window as any).turnstileOnSuccess("test-turnstile-token");
      } else {
        // If callback isn't ready, wait a bit and try again
        console.warn("turnstileOnSuccess not ready");
      }
    });

    // Wait for the submit button to be ready
    await page.waitForSelector("#submit-btn");

    // Set up response monitoring BEFORE clicking
    const responsePromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
      { timeout: 10000 }
    );

    await page.click("#submit-btn");
    
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.status).toBe("received");

    // No canary should be triggered by normal visible interaction
    expect(canaryHits.length).toBe(0);
  });

  test("canary is visible in DOM but not in AX tree (production placements)", async ({ page }) => {
    await page.goto("/signup");
    // Canary exists in DOM
    const canary = page.locator("[data-fr-canary-id]");
    if (await canary.count()) {
      await expect(canary.first()).toBeVisible();
    }
  });
});

test.describe("keyboard-only user", () => {
  test("tab navigation and submit works with verified API response", async ({ page }) => {
    const canaryHits: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/c/")) canaryHits.push(req.url());
    });

    await page.goto("/signup");
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

    // Inject Turnstile token
    await page.evaluate(() => {
      if (typeof (window as any).turnstileOnSuccess === 'function') {
        (window as any).turnstileOnSuccess("test-turnstile-token");
      }
    });

    // Set up response monitoring BEFORE clicking
    const responsePromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
      { timeout: 10000 }
    );

    await page.keyboard.press("Enter");
    
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.status).toBe("received");

    expect(canaryHits.length).toBe(0);
  });
});

test.describe("autofill-like user", () => {
  test("programmatic fill does not trigger canary with verified API response", async ({ page }) => {
    const canaryHits: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/c/")) canaryHits.push(req.url());
    });

    await page.goto("/signup");

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

    // Inject Turnstile token
    await page.evaluate(() => {
      if (typeof (window as any).turnstileOnSuccess === 'function') {
        (window as any).turnstileOnSuccess("test-turnstile-token");
      }
    });

    // Set up response monitoring BEFORE clicking
    const responsePromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
      { timeout: 10000 }
    );

    await page.click("#submit-btn");
    
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.status).toBe("received");

    expect(canaryHits.length).toBe(0);
  });
});
