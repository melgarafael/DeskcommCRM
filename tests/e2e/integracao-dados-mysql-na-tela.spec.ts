/**
 * O MOTOR NA TELA (PostgreSQL ou MySQL) E O AVISO DO TESTE, PELA TELA.
 *
 * A jornada de quem administra a conexão: o cartão diz de qual motor ela é, o
 * aviso do último teste aparece em amarelo separado do erro, o seletor de motor
 * é travado ao editar e sugere a porta ao criar.
 *
 * O que NÃO é o caminho de produção, e por quê: a guarda de rede do conector
 * (`validarHostDeBanco`) bloqueia host privado, então o CI não cria uma conexão
 * MySQL de verdade pela tela (o servidor recusaria o host de mentira). As duas
 * conexões são semeadas no banco e o formulário novo NÃO é enviado.
 *
 * O teste devolve o estado como encontrou: as conexões semeadas são apagadas e
 * o módulo volta ao que era, então roda quantas vezes for preciso.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { test, expect } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";
import { AVISO_ESCRITA } from "../../lib/external-db/dialetos/mysql/grants";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

const EVIDENCIA = path.join(process.cwd(), "evidence", "banco-externo-mysql-na-tela");
function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

const sufixo = randomUUID().slice(0, 6);
const NOME_MYSQL = `Conexão E2E mysql ${sufixo}`;
const NOME_PG = `Conexão E2E pg ${sufixo}`;
const CHAVE_MODULO = "MODULO_BANCO_EXTERNO";

test.use({ viewport: { width: 1600, height: 900 } });
test.describe.configure({ timeout: 300_000 });

let creds: CredsE2E;
let idMysql: string;
let idPg: string;
let moduloAntes: string | null = null;

async function semearConexao(dados: Record<string, unknown>): Promise<string> {
  const criada = await db
    .from("external_db_connections")
    .insert({
      organization_id: (await orgId()),
      host: "banco.exemplo.invalid",
      port: 5432,
      database_name: "e2e",
      username: "leitor",
      password_encrypted: "\\x00",
      password_iv: "\\x00",
      password_tag: "\\x00",
      source_mode: "list",
      sources: [],
      ...dados,
    })
    .select("id")
    .single();
  if (criada.error ?? !criada.data) throw criada.error ?? new Error("não semeou a conexão");
  return (criada.data as { id: string }).id;
}

async function orgId(): Promise<string> {
  const org = await db.from("organizations").select("id").eq("slug", "e2e-test-org").single();
  if (org.error ?? !org.data) throw org.error ?? new Error('organização "e2e-test-org" não encontrada');
  return (org.data as { id: string }).id;
}

test.beforeAll(async () => {
  creds = lerCreds();

  const modulo = await db.from("platform_config").select("valor").eq("chave", CHAVE_MODULO).maybeSingle();
  if (modulo.error) throw modulo.error;
  moduloAntes = (modulo.data?.valor as string | null) ?? null;
  const ligar = await db
    .from("platform_config")
    .upsert({ chave: CHAVE_MODULO, valor: "ligado", eh_segredo: false, semeado_do_env: false }, { onConflict: "chave" });
  if (ligar.error) throw ligar.error;

  idMysql = await semearConexao({
    label: NOME_MYSQL,
    db_type: "mysql",
    port: 3306,
    last_test_ok: true,
    last_test_aviso: AVISO_ESCRITA,
  });
  idPg = await semearConexao({ label: NOME_PG, db_type: "postgres" });
});

test.afterAll(async () => {
  await db.from("external_db_connections").delete().in("id", [idMysql, idPg]);
  if (moduloAntes === null) {
    await db.from("platform_config").delete().eq("chave", CHAVE_MODULO);
  } else {
    await db.from("platform_config").upsert(
      { chave: CHAVE_MODULO, valor: moduloAntes, eh_segredo: false, semeado_do_env: false },
      { onConflict: "chave" },
    );
  }
});

test.describe("Motor e aviso na tela", () => {
  test("1. a lista mostra o selo do motor e o aviso só onde há aviso", async ({ page }) => {
    creds = await loginComoAdmin(page, creds);
    await page.goto("/app/integracao-dados");
    const cartaoMysql = page.locator("div.p-4", { has: page.getByRole("link", { name: NOME_MYSQL }) });
    await expect(cartaoMysql.getByText("MySQL", { exact: true })).toBeVisible();
    await expect(cartaoMysql.getByText(AVISO_ESCRITA)).toBeVisible();
    const cartaoPg = page.locator("div.p-4", { has: page.getByRole("link", { name: NOME_PG }) });
    await expect(cartaoPg.getByText("PostgreSQL", { exact: true })).toBeVisible();
    await expect(cartaoPg.getByText(AVISO_ESCRITA)).toHaveCount(0);
    await page.screenshot({ path: evidencia("01-lista.png") });
  });

  test("2. editar mostra o motor travado e a porta dele", async ({ page }) => {
    creds = await loginComoAdmin(page, creds);
    await page.goto("/app/integracao-dados");
    const cartaoMysql = page.locator("div.p-4", { has: page.getByRole("link", { name: NOME_MYSQL }) });
    await cartaoMysql.getByRole("button", { name: "Editar" }).click();
    await expect(page.locator("#ext-motor")).toBeDisabled();
    await expect(page.locator("#ext-motor")).toContainText("MySQL");
    await expect(page.getByText(/O tipo de banco não muda depois de criado/)).toBeVisible();
    await expect(page.locator("#ext-port")).toHaveValue("3306");
    await page.screenshot({ path: evidencia("02-editar.png") });
    await page.keyboard.press("Escape");
  });

  test("3. criar sugere a porta do motor, mas não mexe na que a pessoa digitou", async ({ page }) => {
    creds = await loginComoAdmin(page, creds);
    await page.goto("/app/integracao-dados");
    await page.getByRole("button", { name: "Nova conexão" }).click();
    await expect(page.locator("#ext-port")).toHaveValue("5432");
    await page.locator("#ext-motor").click();
    await page.getByRole("option", { name: "MySQL" }).click();
    await expect(page.locator("#ext-port")).toHaveValue("3306");
    await expect(page.getByText(/No MySQL, conecte com um usuário só de leitura/)).toBeVisible();
    await expect(page.getByTestId("como-criar-acesso")).toBeVisible();
    await page.getByTestId("como-criar-acesso").locator("summary").click();
    await expect(page.getByTestId("como-criar-acesso").getByText(/CREATE USER 'crm_leitura'/)).toBeVisible();
    await expect(page.getByTestId("como-criar-acesso").getByText(/GRANT SELECT ON NOME_DO_BANCO/)).toBeVisible();
    await page.locator("#ext-port").fill("3307");
    await page.locator("#ext-motor").click();
    await page.getByRole("option", { name: "PostgreSQL" }).click();
    await expect(page.getByTestId("como-criar-acesso")).toHaveCount(0);
    await expect(page.locator("#ext-port")).toHaveValue("3307");
    await page.screenshot({ path: evidencia("03-novo.png") });
  });
});
