import { test, expect } from "./helpers/test";

test("home returns 200 and no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  expect(errors).toEqual([]);
});
