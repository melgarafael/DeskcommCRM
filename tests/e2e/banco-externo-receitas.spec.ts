/**
 * Spec 25, fatia R1 — receita `woocommerce` + instância + tool.
 *
 * Fluxo:
 *   1. Admin liga o módulo `banco_externo`, cadastra uma conexão mysql, adiciona
 *      a receita woocommerce, salva, recarrega e a receita continua lá.
 *   2. Um usuário `agent` da mesma organização não vê o botão de salvar
 *      (somente admin escreve).
 *   3. Pré-visualização com banco inalcançável mostra mensagem legível (não
 *      quebrar a tela).
 *
 * Não precisa de MySQL de verdade: a conexão semeada aponta para um host que não
 * existe, e a pré-visualização com banco inalcançável deve mostrar mensagem
 * legível (a spec confere isso). O que se prova aqui é a TELA: gravar, persistir
 * e o gate de papel.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/banco-externo-receitas.spec.ts
 */

import { test, expect, type Page } from "./helpers/test";

test.describe.configure({ timeout: 60_000 });

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

import { createClient } from "@supabase/supabase-js";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

const CHAVE_MODULO = "MODULO_BANCO_EXTERNO";
const ESPERA = 30_000;

const sufixo = Date.now().toString(36).slice(-4);
const NOME_DA_CONEXAO = `Conexão E2E receitas ${sufixo}`;
let creds: CredsE2E;
let conexaoId: string;
let moduloAntes: string | null = null;

test.use({ viewport: { width: 1600, height: 900 } });

async function loginComoAgent(page: Page, creds: CredsE2E): Promise<void> {
  const usuario = creds.users.agent;
  expect(usuario?.email, "sem `users.agent` em .e2e-creds.json — rode seed-e2e-credentials.ts").toBeTruthy();
  await page.goto("/login");
  await page.locator("#email").fill(usuario!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
}

async function lerConexao(): Promise<{ db_type: string; receitas: unknown[] }> {
  const { data, error } = await db
    .from("external_db_connections")
    .select("db_type, receitas")
    .eq("id", conexaoId)
    .single();
  if (error ?? !data) throw error ?? new Error("conexão semeada sumiu do banco");
  return data as { db_type: string; receitas: unknown[] };
}

test.beforeAll(async () => {
  creds = lerCreds();

  // O módulo banco_externo precisa estar ligado para as rotas /api/v1/external-db/* existirem.
  const modulo = await db.from("platform_config").select("valor").eq("chave", CHAVE_MODULO).maybeSingle();
  if (modulo.error) throw modulo.error;
  moduloAntes = (modulo.data?.valor as string | null) ?? null;
  const ligar = await db
    .from("platform_config")
    .upsert({ chave: CHAVE_MODULO, valor: "ligado", eh_segredo: false, semeado_do_env: false }, { onConflict: "chave" });
  if (ligar.error) throw ligar.error;

  const org = await db.from("organizations").select("id").eq("slug", "e2e-test-org").single();
  if (org.error ?? !org.data) throw org.error ?? new Error('organização "e2e-test-org" não encontrada');

  const criada = await db
    .from("external_db_connections")
    .insert({
      organization_id: (org.data as { id: string }).id,
      label: NOME_DA_CONEXAO,
      host: "banco.exemplo.invalid",
      port: 3306,
      database_name: "e2e",
      username: "leitor",
      password_encrypted: "\\x00",
      password_iv: "\\x00",
      password_tag: "\\x00",
      ssl_mode: "require",
      enabled: true,
      db_type: "mysql",
      receitas: [],
    })
    .select("id")
    .single();
  if (criada.error ?? !criada.data) throw criada.error ?? new Error("não semeou a conexão");
  conexaoId = (criada.data as { id: string }).id;
});

test.afterAll(async () => {
  await db.from("external_db_connections").delete().eq("id", conexaoId);
  if (moduloAntes === null) {
    await db.from("platform_config").delete().eq("chave", CHAVE_MODULO);
  } else {
    await db.from("platform_config").upsert(
      { chave: CHAVE_MODULO, valor: moduloAntes, eh_segredo: false, semeado_do_env: false },
      { onConflict: "chave" },
    );
  }
});

test("admin adiciona a receita woocommerce, salva e persiste após recarregar", async ({ page }) => {
  await loginComoAdmin(page, creds);
  await page.goto(`/app/integracao-dados/${conexaoId}`);

  // Seção "Receitas prontas" só aparece em conexão mysql.
  await expect(page.getByText("Receitas prontas")).toBeVisible({ timeout: ESPERA });

  // Adiciona a receita woocommerce.
  await page.getByRole("button", { name: /adicionar receita/i }).click();

  await page.getByLabel(/rótulo/i).fill("Produtos da loja");
  await page.getByLabel(/descrição/i).fill("Produtos publicados do WooCommerce");
  await page.getByLabel(/prefixo das tabelas/i).fill("wp_");

  await page.getByRole("button", { name: /salvar/i }).click();
  await expect(page.getByText("Salvo.")).toBeVisible({ timeout: ESPERA });

  // Recarrega e a receita continua lá.
  await page.reload();
  await expect(page.getByText("Produtos da loja")).toBeVisible({ timeout: ESPERA });
  await expect(page.getByText("wp_")).toBeVisible({ timeout: ESPERA });

  // Controle: a linha foi gravada no banco com a receita woocommerce.
  const linha = await lerConexao();
  expect(linha.db_type).toBe("mysql");
  expect(Array.isArray(linha.receitas)).toBe(true);
  expect(linha.receitas).toHaveLength(1);
  expect(((linha.receitas as { receita: string }[])[0]!).receita).toBe("woocommerce-produtos");
});

test("usuário agent não vê o botão de salvar", async ({ page }) => {
  // Primeiro o admin grava a receita (setup).
  await loginComoAdmin(page, creds);
  await page.goto(`/app/integracao-dados/${conexaoId}`);
  await expect(page.getByText("Receitas prontas")).toBeVisible({ timeout: ESPERA });
  await page.getByRole("button", { name: /adicionar receita/i }).click();
  await page.getByLabel(/rótulo/i).fill("Produtos da loja");
  await page.getByLabel(/descrição/i).fill("Produtos publicados do WooCommerce");
  await page.getByLabel(/prefixo das tabelas/i).fill("wp_");
  await page.getByRole("button", { name: /salvar/i }).click();
  await expect(page.getByText("Salvo.")).toBeVisible({ timeout: ESPERA });

  // Agora entra como agent da MESMA organização: não deve ver salvar nem adicionar.
  await page.context().clearCookies();
  await loginComoAgent(page, creds);
  await page.goto(`/app/integracao-dados/${conexaoId}`);

  await expect(page.getByText("Receitas prontas")).toBeVisible({ timeout: ESPERA });
  // O agent vê a seção (somente leitura) mas não o botão de salvar nem de adicionar.
  await expect(page.getByRole("button", { name: /salvar/i, exact: false })).not.toBeVisible();
  await expect(page.getByRole("button", { name: /adicionar receita/i })).not.toBeVisible();
});

test("pré-visualização com banco inalcançável mostra mensagem legível", async ({ page }) => {
  await loginComoAdmin(page, creds);
  await page.goto(`/app/integracao-dados/${conexaoId}`);

  await expect(page.getByText("Receitas prontas")).toBeVisible({ timeout: ESPERA });

  // Pré-visualiza (o banco é inalcançável; deve mostrar mensagem, não quebrar a tela).
  await page.getByRole("button", { name: /pré-visualizar/i }).click();
  await page.waitForTimeout(2_000);

  // A tela não fica em branco nem exibe erro de SQL; mostra aviso legível.
  await expect(
    page.locator("body").filter({ hasText: /não foi possível consultar|banco de origem|conexão/i }),
  ).toBeVisible({ timeout: ESPERA });
});
