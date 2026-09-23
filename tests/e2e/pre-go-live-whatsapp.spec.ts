import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { metadataInicialDoCanal } from "../../lib/ai/elegibilidade/pre-go-live";

// Banco e auth reais, sem interceptar a API da feature. Não envia WhatsApp real.
test.use({ locale: "pt-BR" });
test("admin configura testes, remove número, confirma abertura e volta a restringir", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Somente Supabase local");
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const suffix = randomUUID().slice(0, 8);
  const email = `prego-${suffix}@example.test`;
  const password = `E2e-${randomUUID()}!`;
  const orgName = `pre-go-live-${suffix}`;
  execFileSync("pnpm", ["exec", "tsx", "scripts/bootstrap-owner.ts"], {
    env: { ...process.env, OWNER_EMAIL: email, OWNER_PASSWORD: password, OWNER_ORG_NAME: orgName },
    stdio: "pipe",
  });
  const { data: org, error: orgError } = await admin.from("organizations").select("id").eq("slug", orgName).single();
  expect(orgError).toBeNull();
  const orgId = org!.id;
  // Esta spec cobre a configuração do canal após onboarding, não o wizard.
  expect((await admin.from("organizations").update({ onboarded_at: new Date().toISOString() }).eq("id", orgId)).error).toBeNull();
  const { data: channel, error } = await admin.from("channel_sessions").insert({
    organization_id: orgId, display_name: "Canal de validação", waha_session_name: `prego_${suffix}`,
    webhook_secret_encrypted: "\\x00", metadata: metadataInicialDoCanal(), status: "STOPPED",
  }).select("id").single();
  expect(error).toBeNull();
  const channelId = channel!.id;

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/);
  await page.goto("/app/connections");
  await expect(page.getByText("Canal de validação", { exact: true })).toBeVisible();
  await expect(page.getByText("IA em modo de teste", { exact: true })).toBeVisible();
  const openPanel = () => page.getByRole("button", { name: "Configurar acesso da IA" }).click();
  const input = page.getByLabel("Números autorizados para teste");
  const phone = "+5511999998888";
  const read = async () => (await admin.from("channel_sessions").select("metadata").eq("organization_id", orgId).eq("id", channelId).single()).data!.metadata;
  await openPanel();
  await expect(input).toHaveValue("");
  await input.fill("telefone inválido");
  await page.getByRole("button", { name: "Salvar lista de teste" }).click();
  await expect(page.getByRole("dialog", { name: "Acesso da IA no WhatsApp" }).getByRole("alert")).toContainText("Use um telefone com DDI");
  expect((await read()).ai_test_phone_numbers).toEqual([]);
  await input.fill(`${phone}\n+55 (11) 99999-8888\n+14155552671`);
  await page.getByRole("button", { name: "Salvar lista de teste" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_test_phone_numbers).toEqual([phone, "+14155552671"]);
  await page.reload();
  await openPanel();
  await expect(input).toHaveValue(`${phone}\n+14155552671`);
  await input.fill(phone);
  await page.getByRole("button", { name: "Salvar lista de teste" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_test_phone_numbers).toEqual([phone]);
  await openPanel();
  await page.getByRole("button", { name: "Liberar atendimento ao público" }).click();
  await page.getByRole("button", { name: "Continuar em teste" }).click();
  expect((await read()).ai_gate).toBe("allowlist");
  await page.getByRole("button", { name: "Liberar atendimento ao público" }).click();
  await page.getByRole("button", { name: "Confirmar liberação" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_gate).toBe("open");
  expect((await read()).ai_test_phone_numbers).toEqual([phone]);
  await page.reload();
  await expect(page.getByText("IA aberta ao público", { exact: true })).toBeVisible();
  await openPanel();
  await expect(input).toHaveValue(phone);
  await page.getByRole("button", { name: "Ativar modo de teste" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_gate).toBe("allowlist");
  await page.setViewportSize({ width: 390, height: 844 });
  await openPanel();
  await expect(input).toHaveValue(phone);
  const sheet = page.getByRole("dialog", { name: "Acesso da IA no WhatsApp" });
  expect(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByText("Acesso da IA atualizado.", { exact: true })).not.toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: testInfo.outputPath("pre-go-live-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("pre-go-live-desktop.png"), fullPage: true });
  await input.fill("");
  await page.getByRole("button", { name: "Salvar lista de teste" }).click();
  await expect(input).not.toBeVisible();
  expect((await read()).ai_test_phone_numbers).toEqual([]);
});
