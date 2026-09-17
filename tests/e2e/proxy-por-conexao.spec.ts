import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Opt-in: cria somente uma sessão de homologação SEM parear nem enviar mensagens.
// Auth e banco locais reais; pool e transporte externos reais; limpa a sessão no fim.
test("seleciona proxy, confirma vínculo e apresenta QR real", async ({ page }, testInfo) => {
  test.skip(process.env.E2E_EXTERNAL_PROXY !== "true", "Exige WAHA e pool externos de homologação");
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Somente banco local");
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const slug = `proxy-${randomUUID().slice(0, 8)}`, email = `${slug}@example.test`, password = `E2e-${randomUUID()}!`;
  execFileSync("pnpm", ["exec", "tsx", "scripts/bootstrap-owner.ts"], {
    env: { ...process.env, OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_ORG_NAME: slug }, stdio: "pipe",
  });
  const org = (await db.from("organizations").select("id").eq("slug", slug).single()).data!.id;
  await db.from("organizations").update({ onboarded_at: new Date().toISOString() }).eq("id", org);
  try {
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/app/);
    await page.goto("/app/connections");
    const connect = page.getByRole("button", { name: "Conectar novo WhatsApp" });
    await expect(connect).toBeEnabled({ timeout: 60_000 });
    await connect.click();
    await page.getByLabel("País do proxy").selectOption("US");
    await expect(page.getByRole("combobox", { name: /^Proxy da conexão/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("country-only.png"), fullPage: true });
    const responsePromise = page.waitForResponse(r => r.url().endsWith("/api/v1/channel-sessions") && r.request().method() === "POST", { timeout: 120_000 });
    await page.getByRole("button", { name: "Gerar QR Code", exact: true }).click();
    const response = await responsePromise;
    expect(response.request().postDataJSON()).toEqual({ proxy_country: "US" });
    expect(response.ok(), await response.text()).toBe(true);
    const image = page.getByAltText("QR Code para conectar WhatsApp");
    await expect(image).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const binding = await db.from("channel_proxy_bindings").select("proxy_id,country_code").eq("organization_id", org).single();
    expect(binding.data).toEqual({ proxy_id: expect.any(String), country_code: "US" });
    const options = await page.request.get("/api/v1/channel-sessions/proxies");
    expect(await options.text()).not.toMatch(/"(?:password|username|proxy_address|webhook_path_token)"/);
    await page.screenshot({ path: testInfo.outputPath("proxy-qr.png"), fullPage: true });
  } finally {
    const channels = await db.from("channel_sessions").select("id,waha_session_name").eq("organization_id", org);
    for (const channel of channels.data ?? []) {
      const removed = await page.request.delete(`/api/v1/channel-sessions/${channel.id}`);
      expect(removed.ok(), "A sessão de homologação deve ser removida").toBe(true);
    }
  }
});
