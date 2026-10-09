/**
 * GESTÃO DE TENANTS PELO ADMIN DA PLATAFORMA — a jornada inteira, pela tela (J41).
 *
 * ═══ O QUE ESTA SPEC PROVA ═══
 *
 * Duas pessoas: o DONO DO SERVIDOR (admin da plataforma) em
 * `/admin/tenants/<id>`, e um MEMBRO (admin) do tenant.
 *
 *  1. O e-mail de acesso se corrige pela tela, e a prova é o LOGIN com o
 *     endereço novo — o antigo deixa de entrar. A troca segue mesmo sem envio
 *     de e-mail configurado (o estado de um primeiro deploy).
 *  2. A EMPRESA FICA SABENDO: a Central do tenant, vista pelo membro, mostra o
 *     aviso da troca com o nome e sem nenhum endereço.
 *  3. Os dados cadastrais se editam pela tela e o cabeçalho reflete o nome novo.
 *  4. Suspensa por COBRANÇA não se exclui: sem o botão, com a explicação, e a
 *     API responde 409 `exclusao_com_cobranca_pendente`.
 *  5. Excluir uma suspensa ADMINISTRATIVA (suspensa pela tela da main) pede
 *     motivo e o identificador digitado, e apaga: a organização some do banco,
 *     a lápide fica e o login que só pertencia a ela também sai.
 *
 * ═══ O QUE ESTA SPEC NÃO PROVA ═══
 *
 *  - A suspensão em si (quem cai em `/account-suspended`, o que para, a
 *    reativação): é de `suspensao-administrativa.spec.ts`.
 *  - Os desligamentos externos da exclusão (WhatsApp, voz, loja), que só
 *    acontecem DEPOIS do commit: o tenant de teste não tem canal conectado. A
 *    ordem é medida em `lib/tenants/exclusao.test.ts`; a transação, em
 *    `tests/invariants/gestao-de-tenants.test.ts` e
 *    `tests/invariants/exclusao-recusa-cobranca.test.ts`.
 *  - O e-mail ao endereço antigo: sem envio configurado ele não sai (falha
 *    aberta, medida em `.../members/[userId]/email/route.test.ts`).
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
const NOME_DA_PESSOA = `Pessoa Gestão ${SUFIXO}`;

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
    user_metadata: { full_name: NOME_DA_PESSOA },
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

test("corrigir o e-mail, ver o aviso na Central, editar, recusar a exclusão por cobrança e excluir — pela tela", async ({ browser }) => {
  test.setTimeout(300_000);

  const ctxAdmin = await browser.newContext();
  const admin = await ctxAdmin.newPage();
  await loginComoDono(admin, lerCreds());

  // ── 0. O tenant ativo, visto pelo admin ─────────────────────────────────
  await admin.goto(`/admin/tenants/${orgId}`);
  await expect(admin.getByRole("heading", { level: 1, name: NOME })).toBeVisible();
  await expect(admin.getByTestId("membro-email")).toHaveText(EMAIL_ERRADO);
  // Excluir não existe para tenant ativo — só a instrução.
  await expect(admin.getByRole("button", { name: "Excluir tenant" })).toHaveCount(0);
  await expect(admin.getByText("Para excluir um tenant, suspenda-o primeiro.")).toBeVisible();
  await foto(admin, "01-ativo");

  // ── 1. Corrigir o e-mail de acesso ──────────────────────────────────────
  await admin.getByRole("button", { name: "Alterar e-mail" }).click();
  await admin.locator("#novo-email").fill(EMAIL_CERTO);
  await admin.getByRole("button", { name: "Salvar e-mail" }).click();
  await expect(admin.getByTestId("membro-email")).toHaveText(EMAIL_CERTO);
  await foto(admin, "02-email-corrigido");

  // O endereço novo entra; o antigo não entra mais.
  const ctxNovo = await browser.newContext();
  const novo = await ctxNovo.newPage();
  await entrarComo(novo, EMAIL_CERTO);
  await novo.waitForURL(/\/app/, { timeout: 45_000 });
  const ctxAntigo = await browser.newContext();
  const antigo = await ctxAntigo.newPage();
  await entrarComo(antigo, EMAIL_ERRADO);
  await expect(antigo).toHaveURL(/\/login/);
  await ctxAntigo.close();

  // ── 2. A Central da empresa avisa — com o nome, sem endereço ────────────
  await novo.goto("/app/ai/inbox");
  const aviso = novo.getByTestId("inbox-item").filter({ hasText: "foi trocado pelo administrador da plataforma" });
  await expect(aviso).toHaveCount(1, { timeout: 15_000 });
  await expect(aviso).toContainText(NOME_DA_PESSOA);
  expect(await aviso.innerText()).not.toContain("@");
  await expect(aviso.getByRole("link", { name: "Abrir a equipe" })).toHaveAttribute("href", "/app/team");
  await foto(novo, "03-central-avisa");

  // ── 3. Editar dados cadastrais ──────────────────────────────────────────
  const nomeNovo = `${NOME} Renomeada`;
  await admin.getByRole("button", { name: "Editar dados" }).click();
  await admin.locator("#display_name").fill(nomeNovo);
  await admin.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(admin.getByRole("heading", { level: 1, name: nomeNovo })).toBeVisible({ timeout: 15_000 });
  const { data: gravada } = await db.from("organizations").select("display_name").eq("id", orgId).single();
  expect(gravada?.display_name).toBe(nomeNovo);
  await foto(admin, "04-dados-editados");

  // ── 4. Suspensa por COBRANÇA não se exclui ──────────────────────────────
  // Preparada pelo service role, como a cobrança faria: o gatilho da 0501 só
  // barra `authenticated`/`anon`, e não há tela que suspenda por cobrança.
  const porCobranca = await db
    .from("organizations")
    .update({
      status: "suspended",
      suspended_kind: "cobranca",
      suspended_at: new Date().toISOString(),
      suspended_reason: "Cobrança em aberto — teste e2e",
    })
    .eq("id", orgId);
  if (porCobranca.error) throw porCobranca.error;
  await admin.reload();
  // A main esconde "Reativar tenant" na suspensão por cobrança (a saída é o card
  // Cobrança); o sinal de que a tela recarregou é o tipo da suspensão.
  await expect(admin.getByTestId("tipo-da-suspensao")).toHaveText("Suspensa por falta de pagamento", { timeout: 15_000 });
  await expect(admin.getByRole("button", { name: "Reativar tenant" })).toHaveCount(0);
  await expect(admin.getByRole("button", { name: "Excluir tenant" })).toHaveCount(0);
  await expect(
    admin.getByText("Suspensa por falta de pagamento: não pode ser excluída enquanto houver cobrança pendente."),
  ).toBeVisible();
  const recusa = await admin.request.post(`/api/v1/admin/tenants/${orgId}/delete`, {
    data: { confirmacao: SLUG, motivo: "Tentativa de excluir com cobrança pendente" },
  });
  expect(recusa.status()).toBe(409);
  expect(((await recusa.json()) as { error: { code: string } }).error.code).toBe("exclusao_com_cobranca_pendente");
  expect((await db.from("organizations").select("id").eq("id", orgId)).data ?? []).toHaveLength(1);
  await foto(admin, "05-cobranca-nao-exclui");

  // ── 5. Suspensa ADMINISTRATIVA pela tela, e excluída ────────────────────
  const devolta = await db
    .from("organizations")
    .update({ status: "active", suspended_kind: null, suspended_at: null, suspended_reason: null })
    .eq("id", orgId);
  if (devolta.error) throw devolta.error;
  await admin.reload();
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
  await foto(admin, "06-confirmacao-da-exclusao");
  await expect(excluir).toBeEnabled();
  await excluir.click();
  await admin.waitForURL(/\/admin\/tenants$/, { timeout: 60_000 });
  await foto(admin, "07-lista-depois");

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

  await Promise.all([ctxAdmin.close(), ctxNovo.close()]);
});
