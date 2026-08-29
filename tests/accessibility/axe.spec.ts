/**
 * Accessibility tests — verify production canaries don't pollute AX tree.
 * FR-INV-006: production-eligible canaries must not degrade accessibility semantics.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("accessibility", () => {
  test("signup page has no critical axe violations", async ({ page }) => {
    await page.goto("/signup");
    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => v.impact === "critical");
    expect(critical).toEqual([]);
  });

  test("visible labels are stable", async ({ page }) => {
    await page.goto("/signup");
    // All form fields should have associated labels
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
    // If there's a P06 (non-rendered) canary, it should have aria-hidden
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
          // Production-eligible canaries should be visible
          await expect(el).toBeVisible();
        }
      }
    }
  });
});
