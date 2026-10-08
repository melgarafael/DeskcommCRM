/**
 * E2E: sem a chave de cobrança, nada muda (spec da cobrança do revendedor §1.2,
 * §9, §12 — `cobranca-desligada.spec.ts`).
 *
 * O self-hoster de empresa única vê o formulário de novo tenant com o rótulo
 * "Plano", o painel do tenant sem card de cobrança, /admin/sistema com o
 * interruptor DESLIGADO, a tela Billing como antes, nenhuma faixa,
 * nenhum item de admin, e "Recursos opcionais" sem a cobrança.
 *
 * Precondição medida, não suposta (Review Focus 5): a chave é da INSTALAÇÃO, e
 * uma spec anterior que falhasse antes da limpeza a deixaria ligada. Esta spec
 * a apaga e confere a ausência antes de qualquer passo.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { test, expect, type Page } from "./helpers/test";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;
const sufixo = randomUUID().slice(0, 8);
const EVIDENCIA = "evidence/cobranca-planos-e-limites";
const CHAVE = "MODULO_COBRANCA";

async function entrar(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 60_000 });
}

test("sem a chave, nada da cobrança aparece e o que existia segue igual", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  mkdirSync(EVIDENCIA, { recursive: true });
  let donoId: string | null = null;
  let orgId: string | null = null;
  let falhaDoCenario: unknown;

  try {
    const apaga = await db.from("platform_config").delete().eq("chave", CHAVE);
    if (apaga.error) throw apaga.error;
    const resto = await db.from("platform_config").select("chave").eq("chave", CHAVE);
    if (resto.error) throw resto.error;
    expect(resto.data).toEqual([]);

    const email = `cob-desligada-${sufixo}@invariant.test`;
    const criado = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
    if (criado.error || !criado.data.user) throw criado.error ?? new Error("não criou o dono");
    donoId = criado.data.user.id;
    const org = await db.from("organizations").insert({
      slug: `cob-desligada-${sufixo}`, display_name: `Empresa única ${sufixo}`, legal_name: "Empresa única",
      onboarded_at: new Date().toISOString(), settings: { plan: "pro" },
    }).select("id").single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    const vinculo = await db.from("user_organizations").insert({
      organization_id: orgId, user_id: donoId, role: "admin", accepted_at: new Date().toISOString(),
    });
    if (vinculo.error) throw vinculo.error;
    const pa = await db.from("platform_admins").insert({
      user_id: donoId, granted_by: donoId, scope: "full", mfa_required: false, reason: "E2E cobrança desligada",
    });
    if (pa.error) throw pa.error;

    await entrar(page, email);

    // ── O dono: nada de cobrança no admin ───────────────────────────────────
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("link", { name: "Tenants" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Cobrança" })).toHaveCount(0);
    expect((await page.goto("/admin/cobranca"))?.status()).toBe(404);

    await page.goto("/admin/tenants/new");
    await expect(page.getByRole("combobox", { name: "Plano" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Plano de cobrança" })).toHaveCount(0);
    await page.screenshot({ path: `${EVIDENCIA}/desligada-novo-tenant.png`, fullPage: true });

    await page.goto(`/admin/tenants/${orgId}`);
    await expect(page.getByRole("heading", { name: "Cobrança" })).toHaveCount(0);

    await page.goto("/admin/sistema");
    await expect(page.getByRole("switch", { name: "Banco de dados externo" })).toBeVisible();
    // PR 3a: a chave saiu de MODULOS_AINDA_NAO_LIGAVEIS — o interruptor aparece para todo dono, DESLIGADO.
    await expect(page.getByRole("switch", { name: "Cobrança dos seus clientes" })).toHaveAttribute("aria-checked", "false");

    // ── A empresa: Billing como antes, nenhuma faixa, recursos sem cobrança ─
    await page.goto("/app/settings/billing");
    await expect(page.getByRole("heading", { name: "Plano e cobrança" })).toBeVisible();
    await expect(page.getByText("Em breve — Fase 2")).toBeVisible();
    await expect(page.getByText(/teste grátis/i)).toHaveCount(0);
    await page.screenshot({ path: `${EVIDENCIA}/desligada-billing.png`, fullPage: true });

    await page.goto("/app/settings/recursos");
    // Controle positivo: a tela da EMPRESA só renderiza os níveis instalacao+modulo,
    // organizacao e agente; "email" é nível "servidor" e só aparece em /admin/sistema.
    await expect(page.locator('[data-recurso="modulo:banco_externo"]')).toBeVisible();
    await expect(page.getByText("Cobrança dos seus clientes")).toHaveCount(0);
    await page.screenshot({ path: `${EVIDENCIA}/desligada-recursos-opcionais.png`, fullPage: true });
  } catch (erro) {
    falhaDoCenario = erro;
    throw erro;
  } finally {
    try {
      if (orgId) {
        const r = await db.from("organizations").delete().eq("id", orgId);
        if (r.error) throw r.error;
      }
      if (donoId) {
        const pa = await db.from("platform_admins").delete().eq("user_id", donoId);
        if (pa.error) throw pa.error;
        const r = await db.auth.admin.deleteUser(donoId);
        if (r.error) throw r.error;
      }
    } catch (erroDaLimpeza) {
      test.info().annotations.push({ type: "cleanup", description: `limpeza incompleta: org ${orgId ?? "-"}` });
      if (!falhaDoCenario) throw erroDaLimpeza;
    }
  }
});
