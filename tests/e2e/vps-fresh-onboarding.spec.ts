/**
 * J1 — Onboarding do primeiro usuário numa instalação FRESCA (estilo VPS).
 *
 * Pré-condições (ambiente que simula o kit self-host):
 *   - banco zerado do baseline.sql (Supabase local pg17)
 *   - primeiro usuário criado via scripts/bootstrap-owner.ts, que espelha o
 *     bootstrap do install.sh (o instalador refaz o passo em bash, não chama o script)
 *   - WAHA ativo, Redis local, RESEND_API_KEY VAZIO (realidade da VPS fresca)
 *   - app em produção (next build + next start) na E2E_PORT
 *
 * Casos: J1.1–J1.13 do docs/testing/user-journey-map.md. Tudo pelo frontend;
 * banco só para PROVAR estado (nunca para atalhar a jornada).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const OWNER_EMAIL = "dono@qa.local";
const OWNER_PASSWORD = "QaVps!2026#Dono";
const OWNER_STATE_PATH = path.join(process.cwd(), ".e2e-owner.json");
const EVIDENCE_DIR = path.join(process.cwd(), ".superpowers/evidence/vps-qa");

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function orgRow(): Promise<{
  id: string;
  display_name: string;
  timezone: string | null;
  onboarded_at: string | null;
  onboarding_state: Record<string, unknown> | null;
}> {
  const { data, error } = await svc
    .from("organizations")
    .select("id, display_name, timezone, onboarded_at, onboarding_state")
    .limit(1)
    .single();
  if (error) throw error;
  return data as never;
}

async function snap(page: Page, name: string): Promise<void> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
}

async function login(page: Page, password = OWNER_PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(OWNER_EMAIL);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /entrar/i }).click();
}

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.describe("J1 — onboarding do dono numa instalação fresca", () => {
  test.beforeAll(async () => {
    // Reset ao estado recém-bootstrapado (re-runs idempotentes): wizard zerado,
    // sem agente, sem canal, sem fatores MFA do dono.
    const org = await orgRow();
    await svc
      .from("organizations")
      .update({ onboarding_state: {}, onboarded_at: null })
      .eq("id", org.id);
    await svc.from("ai_agents").delete().eq("organization_id", org.id);
    await svc.from("channel_sessions").delete().eq("organization_id", org.id);

    const { data: users } = await svc.auth.admin.listUsers();
    const owner = users?.users.find((u) => u.email === OWNER_EMAIL);
    if (owner) {
      const { data: factors } = await svc.auth.admin.mfa.listFactors({ userId: owner.id });
      for (const f of factors?.factors ?? []) {
        await svc.auth.admin.mfa.deleteFactor({ id: f.id, userId: owner.id });
      }
    }
    if (fs.existsSync(OWNER_STATE_PATH)) fs.rmSync(OWNER_STATE_PATH);

    // WAHA: remove sessões org_* de rodadas anteriores (instalação fresca não
    // teria sessão FAILED pendurada; QR não re-renderiza sobre sessão morta).
    const wahaBase = process.env.WAHA_API_BASE_URL;
    const wahaKey = process.env.WAHA_API_KEY;
    if (wahaBase && wahaKey) {
      const res = await fetch(`${wahaBase}/api/sessions?all=true`, {
        headers: { "X-Api-Key": wahaKey },
      }).catch(() => null);
      const sessions = res?.ok ? ((await res.json()) as Array<{ name: string }>) : [];
      for (const s of sessions) {
        if (!s.name.startsWith("org_")) continue;
        await fetch(`${wahaBase}/api/sessions/${s.name}`, {
          method: "DELETE",
          headers: { "X-Api-Key": wahaKey },
        }).catch(() => null);
      }
    }
  });

  test("J1.2 senha errada → mensagem clara, sem stack", async ({ page }) => {
    await login(page, "senha-errada-123");
    await expect(page.getByText(/email ou senha incorretos/i)).toBeVisible({ timeout: 10_000 });
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/error:|stack|exception/i);
    await snap(page, "j1.2-senha-errada");
  });

  test("J1.1 login do bootstrap cai no wizard (org sem onboarded_at)", async ({ page }) => {
    const before = await orgRow();
    expect(before.onboarded_at).toBeNull();
    await login(page);
    await page.waitForURL(/\/onboarding/, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/onboarding\/welcome/);
    await snap(page, "j1.1-welcome");
  });

  test("J1.12 /app/inbox antes de concluir → volta pro onboarding", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding/);
    await page.goto("/app/inbox");
    await page.waitForURL(/\/onboarding/, { timeout: 15_000 });
  });

  test("J1.3 + J1.4 welcome: termos obrigatórios; salva nome/timezone e avança", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/welcome/);

    // J1.3 — sem aceitar os termos o botão fica desabilitado
    const continuar = page.getByRole("button", { name: /continuar/i });
    await expect(continuar).toBeDisabled();

    // J1.4 — preenche e avança
    await page.locator("#display_name").fill("Loja QA VPS");
    await page.locator('input[type="checkbox"]').check();
    await expect(continuar).toBeEnabled();
    await continuar.click();
    await page.waitForURL(/\/onboarding\/connect-whatsapp/, { timeout: 20_000 });
    await snap(page, "j1.4-connect-whatsapp");

    const org = await orgRow();
    expect(org.display_name).toBe("Loja QA VPS");
    expect(org.timezone).toBe("America/Sao_Paulo");
    expect((org.onboarding_state as { welcome?: unknown })?.welcome).toBeTruthy();
  });

  test("J1.5 WAHA ativo → QR code aparece de verdade", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/connect-whatsapp/);

    // sem banner de "WAHA não está configurado"
    await expect(page.getByText(/waha não está configurado/i)).toHaveCount(0);

    // QR do proxy (poll de 3s até SCAN_QR_CODE) — imagem carregada de fato
    const qr = page.locator('img[src*="/whatsapp/qr"]');
    await expect(qr).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => qr.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await snap(page, "j1.5-qr-visivel");
  });

  test("J1.11 + J1.6 abandona e volta → retoma no step pendente; pular WhatsApp avança", async ({ page }) => {
    // sessão nova (simula fechar o browser): retoma exatamente no connect-whatsapp
    await login(page);
    await page.waitForURL(/\/onboarding\/connect-whatsapp/, { timeout: 20_000 });

    // Com Nuvemshop desabilitado (VPS fresca), pular o WhatsApp deve cair
    // DIRETO no setup de IA — nunca num step oculto (bug corrigido: as actions
    // redirecionavam hardcoded pro connect-nuvemshop).
    await page.getByRole("button", { name: /pular por enquanto/i }).click();
    await page.waitForURL(/\/onboarding\/setup-ai/, { timeout: 20_000 });
    await snap(page, "j1.6-setup-ai");
  });

  test("J1.7 setup IA: cria agente default e avança", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/setup-ai/);

    await page.locator("#name").fill("Tomik QA");
    await page.getByRole("button", { name: /criar e continuar/i }).click();
    await page.waitForURL(/\/onboarding\/invite-team/, { timeout: 20_000 });
    await snap(page, "j1.7-invite-team");

    const { data: agents } = await svc.from("ai_agents").select("name, is_active, is_default");
    expect(agents?.length).toBe(1);
    expect(agents?.[0]).toMatchObject({ name: "Tomik QA", is_active: true, is_default: true });
  });

  test("J1.8 convite SEM Resend: a UI não pode mentir que enviou email", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/invite-team/);

    await page.locator("#emails").fill("atendente@qa.local");
    await page.getByRole("button", { name: /enviar convites/i }).click();

    // Honestidade: sem RESEND_API_KEY nenhum email sai. A UI deve dizer isso
    // e oferecer o link de aceite copiável (nunca redirecionar em silêncio).
    await expect(page.getByText(/não está configurado neste servidor/i)).toBeVisible({
      timeout: 15_000,
    });
    const acceptUrl = (
      await page.locator("code", { hasText: /team\/accept-invite/ }).first().innerText()
    ).trim();
    expect(acceptUrl).toMatch(/\/team\/accept-invite\/.+/);
    fs.writeFileSync(
      path.join(process.cwd(), ".e2e-invite-url.json"),
      JSON.stringify({ email: "atendente@qa.local", accept_url: acceptUrl }, null, 2),
    );
    await snap(page, "j1.8-convite-sem-resend");

    // e o wizard segue em frente conscientemente
    await page.getByRole("button", { name: /^continuar$/i }).click();
    await page.waitForURL(/\/onboarding\/done/, { timeout: 20_000 });
  });

  test("J1.9 done → onboarded_at setado e cai no inbox", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/onboarding\/done/);
    await snap(page, "j1.9-done-recap");

    await page.getByRole("button", { name: /ir para o inbox/i }).click();
    await page.waitForURL(/\/app\/inbox/, { timeout: 30_000 });

    const org = await orgRow();
    expect(org.onboarded_at).not.toBeNull();
  });

  test("J1.10 gate MFA: enrola TOTP e VÊ os códigos de recuperação (regressão do bug do gate)", async ({ page }) => {
    await login(page);
    await page.waitForURL(/\/app\//, { timeout: 30_000 });

    // blocker não-dismissível
    await expect(
      page.getByRole("heading", { name: /verificação em duas etapas/i }),
    ).toBeVisible({ timeout: 20_000 });
    await snap(page, "j1.10-mfa-gate");

    await page.getByRole("button", { name: /iniciar configuração/i }).click();
    await expect(
      page.locator('img[alt="QR code para configurar autenticador"]'),
    ).toBeVisible({ timeout: 20_000 });

    // secret manual (o que um leigo digitaria no app autenticador)
    await page.getByText(/não consegue escanear/i).click();
    const secret = (await page.locator("code").innerText()).trim();
    expect(secret.length).toBeGreaterThan(15);
    fs.writeFileSync(
      OWNER_STATE_PATH,
      JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, totp_secret: secret }, null, 2),
    );

    // digita o código com retry na virada da janela TOTP
    for (let attempt = 0; attempt < 3; attempt++) {
      if (msUntilNextTotpWindow() < 4_000) await page.waitForTimeout(msUntilNextTotpWindow() + 300);
      await page.locator('input[aria-label="Dígito 1"]').click();
      await page.keyboard.type(generateTotp(secret), { delay: 40 });
      try {
        await expect(page.getByRole("heading", { name: /códigos de recuperação/i })).toBeVisible({
          timeout: 8_000,
        });
        break;
      } catch {
        if (attempt === 2) throw new Error("MFA enroll não chegou aos recovery codes");
        // código recusado (janela virou) → limpa e tenta de novo
        await page.locator('input[aria-label="Dígito 1"]').click();
        for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
      }
    }

    // O BUG: a revalidação do server action desmontava o gate e o usuário
    // caía no inbox sem ver estes códigos. Prova de que a tela persiste com os
    // 10 códigos + ações de salvar (grid font-mono no RecoveryCodesPanel).
    await expect(page.getByText(/salve esses 10 códigos/i)).toBeVisible();
    const codes = page.locator("div.font-mono");
    await expect(codes).toHaveCount(10);
    await expect(page.getByRole("button", { name: /copiar todos/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /baixar \.txt/i })).toBeVisible();
    await snap(page, "j1.10-recovery-codes");

    await page.getByText(/salvei meus códigos/i).click();
    await page.getByRole("button", { name: /^concluir$/i }).click();

    // gate some após reload; shell do app visível
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { name: /verificação em duas etapas/i }),
    ).toHaveCount(0, { timeout: 20_000 });
    await snap(page, "j1.10-inbox-livre");
  });

  test("J1.13 wizard não reabre depois de concluído", async ({ page }) => {
    // agora o login do dono exige TOTP
    const state = JSON.parse(fs.readFileSync(OWNER_STATE_PATH, "utf8")) as { totp_secret: string };
    await login(page);
    await page.waitForURL(/\/login\/mfa/, { timeout: 20_000 });
    if (msUntilNextTotpWindow() < 4_000) await page.waitForTimeout(msUntilNextTotpWindow() + 300);
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(state.totp_secret), { delay: 40 });
    await page.waitForURL(/\/app\//, { timeout: 30_000 });

    await page.goto("/onboarding");
    await page.waitForURL(/\/app\/inbox/, { timeout: 15_000 });
  });
});
