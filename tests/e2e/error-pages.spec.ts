import { test, expect } from "@playwright/test";

test.describe("error pages", () => {
  test("/404 renders PT-BR copy", async ({ page }) => {
    const res = await page.goto("/404");
    // Next renders the not-found.tsx component; status may be 404 or 200 depending on routing.
    expect([200, 404]).toContain(res?.status() ?? 0);
    await expect(page.getByText(/não encontrada/i)).toBeVisible();
  });

  test("/403 renders sem permissão", async ({ page }) => {
    await page.goto("/403");
    await expect(page.getByText(/sem permissão/i)).toBeVisible();
  });

  test("/500 renders erro interno", async ({ page }) => {
    await page.goto("/500");
    await expect(page.getByText(/erro interno/i)).toBeVisible();
  });

  test("/503 renders manutenção", async ({ page }) => {
    await page.goto("/503");
    await expect(page.getByText(/manutenção/i)).toBeVisible();
  });
});
