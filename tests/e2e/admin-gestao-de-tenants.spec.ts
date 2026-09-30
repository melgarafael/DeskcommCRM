/**
 * GESTÃO DE TENANTS PELO ADMIN DA PLATAFORMA — a jornada inteira, pela tela.
 *
 * ═══ O QUE ESTA SPEC PROVA ═══
 *
 * Duas pessoas, dois navegadores: o DONO DO SERVIDOR (admin da plataforma) em
 * `/admin/tenants/<id>`, e um MEMBRO do tenant, logado ao mesmo tempo.
 *
 *  1. Suspender corta o membro de verdade: a próxima navegação dele cai em
 *     `/account-suspended`, e a API responde `403 tenant_suspended`. Até a
 *     migration 0492 a suspensão só escondia a tela (auditoria 28/09/2026, P3).
 *  2. O e-mail de acesso se corrige pela tela, e a prova é o LOGIN com o
 *     endereço novo — o antigo deixa de entrar.
 *  3. Reativar devolve o acesso.
 *  4. Os dados cadastrais se editam pela tela e o cabeçalho reflete o nome novo.
 *  5. Excluir só existe para tenant suspenso, pede motivo e o identificador
 *     digitado, e apaga: a organização some do banco e o login que só
 *     pertencia a ela também.
 *
 * ═══ O QUE ESTA SPEC NÃO PROVA ═══
 *
 *  - Os desligamentos externos da exclusão (WAHA, Meta, Nuvemshop): o tenant
 *    de teste não tem canal conectado. O orquestrador é medido em
 *    `lib/tenants/exclusao.test.ts`; a transação, em
 *    `tests/invariants/gestao-de-tenants.test.ts`.
 *  - A fila do agente e o dreno de eventos parados na suspensão (sem WAHA no
 *    teste): medidos por unidade e pelo invariante.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoDono } from "./helpers/login-admin";
import { afirmarDonoDoServidor } from "./utils/precondicao";

const { url, serviceRole } = credenciaisSupabaseDeTeste();
const db = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

const EVIDENCIA = path.join(process.cwd(), "evidence", "admin-gestao-de-tenants");
const SUFIXO = Date.now().toString(36);
const SLUG = `e2e-gestao-${SUFIXO}`;
const NOME = `Empresa Gestão ${SUFIXO}`;
const SENHA = `Senha-e2e-${SUFIXO}!`;
const EMAIL_ERRADO = `digitado-errado-${SUFIXO}@exemplo.test`;
const EMAIL_CERTO = `corrigido-${SUFIXO}@exemplo.test`;

let orgId = "";
let membroId = "";

async function foto(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function entrarComo(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // Quem alcança `/admin/**` é o dono do servidor (`platform_admins`). Num banco
  // semeado do zero ele não existe: a precondição o promove, como na irmã
  // `admin-credencial-google.spec.ts`.
  await afirmarDonoDoServidor(lerCreds().users.dono!.email);

  const { data: u, error: ue } = await db.auth.admin.createUser({
    email: EMAIL_ERRADO,
    password: SENHA,
    email_confirm: true,
  });
  if (ue || !u.user) throw new Error(`createUser: ${ue?.message}`);
  membroId = u.user.id;

  const { data: org, error: oe } = await db
    .from("organizations")
    .insert({ slug: SLUG, legal_name: `${NOME} LTDA`, display_name: NOME, onboarded_at: new Date().toISOString() })
    .select("id")
    .single();
  if (oe || !org) throw new Error(`organizations: ${oe?.message}`);
  orgId = org.id as string;

  const { error: me } = await db
    .from("user_organizations")
    .insert({ user_id: membroId, organization_id: orgId, role: "admin", accepted_at: new Date().toISOString() });
  if (me) throw new Error(`user_organizations: ${me.message}`);
});

test.afterAll(async () => {
  // A exclusão pela tela já deveria ter levado tudo; isto é só a rede de
  // segurança para quando um passo anterior falhar.
  if (orgId) await db.from("organizations").delete().eq("id", orgId);
  if (membroId) await db.auth.admin.deleteUser(membroId).catch(() => undefined);
});

test("suspender, corrigir o e-mail, reativar, editar e excluir — pela tela", async ({ browser }) => {
  test.setTimeout(300_000);

  const ctxAdmin = await browser.newContext();
  const admin = await ctxAdmin.newPage();
  await loginComoDono(admin, lerCreds());

  const ctxMembro = await browser.newContext();
  const membro = await ctxMembro.newPage();
  await entrarComo(membro, EMAIL_ERRADO);
  await membro.waitForURL(/\/app/, { timeout: 45_000 });

  // ── 0. O tenant ativo, visto pelo admin ─────────────────────────────────
  await admin.goto(`/admin/tenants/${orgId}`);
  await expect(admin.getByRole("heading", { level: 1, name: NOME })).toBeVisible();
  await expect(admin.getByTestId("membro-email")).toHaveText(EMAIL_ERRADO);
  // Excluir não existe para tenant ativo — só a instrução.
  await expect(admin.getByRole("button", { name: "Excluir tenant" })).toHaveCount(0);
  await expect(admin.getByText("Para excluir um tenant, suspenda-o primeiro.")).toBeVisible();
  await foto(admin, "01-tenant-ativo");

  // ── 1. Suspender corta o membro ─────────────────────────────────────────
  await admin.getByRole("button", { name: "Suspender tenant" }).click();
  await admin.locator("#suspend-reason").fill("Inadimplência — teste de ponta a ponta");
  await admin.getByRole("button", { name: "Confirmar suspensão" }).click();
  await expect(admin.getByRole("dialog")).toHaveCount(0);
  await expect(admin.getByRole("region", { name: "Tenant Suspenso" })).toBeVisible();
  await expect(admin.getByRole("button", { name: "Excluir tenant" })).toBeVisible();
  await foto(admin, "02-tenant-suspenso");

  await membro.goto("/app/inbox");
  await membro.waitForURL(/\/account-suspended/, { timeout: 30_000 });
  await expect(membro.getByRole("heading", { name: "Conta suspensa" })).toBeVisible();
  const api = await membro.request.get("/api/v1/contacts");
  expect(api.status()).toBe(403);
  expect(((await api.json()) as { error: { code: string } }).error.code).toBe("tenant_suspended");
  await foto(membro, "03-membro-ve-conta-suspensa");

  // ── 2. Corrigir o e-mail de acesso ──────────────────────────────────────
  await admin.getByRole("button", { name: "Alterar e-mail" }).click();
  await admin.locator("#novo-email").fill(EMAIL_CERTO);
  await admin.getByRole("button", { name: "Salvar e-mail" }).click();
  await expect(admin.getByTestId("membro-email")).toHaveText(EMAIL_CERTO);
  await foto(admin, "04-email-corrigido");

  // O endereço novo entra (e, com o tenant suspenso, cai na tela de suspensão);
  // o antigo não entra mais.
  const ctxNovo = await browser.newContext();
  const novo = await ctxNovo.newPage();
  await entrarComo(novo, EMAIL_CERTO);
  await novo.waitForURL(/\/account-suspended/, { timeout: 45_000 });
  const ctxAntigo = await browser.newContext();
  const antigo = await ctxAntigo.newPage();
  await entrarComo(antigo, EMAIL_ERRADO);
  await expect(antigo).toHaveURL(/\/login/);
  await ctxAntigo.close();

  // ── 3. Reativar devolve o acesso ────────────────────────────────────────
  await admin.getByRole("button", { name: "Reativar tenant" }).click();
  await admin.getByRole("textbox").last().fill("Pagamento regularizado — teste e2e");
  await admin.getByRole("button", { name: "Confirmar reativação" }).click();
  // Esperar pelo BANCO e pelo botão que só existe para tenant ativo. "O aviso
  // sumiu" não serve: com o diálogo modal aberto, o Radix tira o resto da página
  // da árvore de acessibilidade, e a asserção passaria antes da gravação.
  await expect
    .poll(async () => (await db.from("organizations").select("status").eq("id", orgId).single()).data?.status, {
      timeout: 15_000,
    })
    .toBe("active");
  await expect(admin.getByRole("button", { name: "Suspender tenant" })).toBeVisible({ timeout: 15_000 });
  await expect(admin.getByRole("region", { name: "Tenant Suspenso" })).toHaveCount(0);
  await novo.goto("/app/inbox");
  await expect(novo).toHaveURL(/\/app\//, { timeout: 30_000 });
  await expect(novo).not.toHaveURL(/account-suspended/);
  await foto(novo, "05-membro-de-volta");

  // ── 4. Editar dados cadastrais ──────────────────────────────────────────
  const nomeNovo = `${NOME} Renomeada`;
  await admin.getByRole("button", { name: "Editar dados" }).click();
  await admin.locator("#display_name").fill(nomeNovo);
  await admin.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(admin.getByRole("heading", { level: 1, name: nomeNovo })).toBeVisible({ timeout: 15_000 });
  const { data: gravada } = await db.from("organizations").select("display_name").eq("id", orgId).single();
  expect(gravada?.display_name).toBe(nomeNovo);
  await foto(admin, "06-dados-editados");

  // ── 5. Excluir: suspender de novo, confirmar pelo identificador ─────────
  await admin.getByRole("button", { name: "Suspender tenant" }).click();
  await admin.locator("#suspend-reason").fill("Encerramento do contrato — teste e2e");
  await admin.getByRole("button", { name: "Confirmar suspensão" }).click();
  await expect(admin.getByRole("dialog")).toHaveCount(0);
  await admin.getByRole("button", { name: "Excluir tenant" }).click();
  const excluir = admin.getByRole("button", { name: "Excluir definitivamente" });
  await expect(admin.getByText("Esta ação é irreversível.", { exact: false })).toBeVisible();
  await admin.locator("#delete-reason").fill("Contrato encerrado a pedido do cliente");
  await admin.locator("#delete-confirm").fill("slug-errado");
  await expect(excluir).toBeDisabled();
  await admin.locator("#delete-confirm").fill(SLUG);
  await foto(admin, "07-confirmacao-da-exclusao");
  await expect(excluir).toBeEnabled();
  await excluir.click();
  await admin.waitForURL(/\/admin\/tenants$/, { timeout: 60_000 });
  await foto(admin, "08-lista-depois-da-exclusao");

  const { data: sobra } = await db.from("organizations").select("id").eq("id", orgId);
  expect(sobra ?? []).toHaveLength(0);
  const { data: lapide } = await db
    .from("api_audit_log")
    .select("action")
    .eq("resource_id", orgId)
    .eq("action", "organization.deleted");
  expect(lapide ?? []).toHaveLength(1);
  // O login pertencia só a este tenant: foi removido junto.
  const { data: login } = await db.auth.admin.getUserById(membroId);
  expect(login?.user ?? null).toBeNull();

  await Promise.all([ctxAdmin.close(), ctxMembro.close(), ctxNovo.close()]);
});
