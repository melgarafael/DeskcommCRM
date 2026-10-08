/**
 * O PAINEL "O QUE O ASSISTENTE PODE VER", PELA TELA.
 *
 * A jornada de quem administra a conexão de banco externo e escolhe o que o
 * assistente pode ler: conexão nova nasce sem nada liberado e a tela leva a
 * pessoa ao painel; marcar e salvar persiste; o modo "tudo" avisa forte; quem
 * só lê vê a lista sem editar.
 *
 * O que NÃO é o caminho de produção, e por quê: a guarda de rede do conector
 * (`validarHostDeBanco`) bloqueia toda faixa privada, então o CI não conecta
 * um banco real. `GET/PUT sources` não abrem o banco externo — rodam de
 * verdade. Só o catálogo é simulado na rede (`page.route`, antes do `goto`),
 * com o formato `TabelaExterna` que a rota devolveria.
 *
 * O teste devolve o estado como encontrou: a conexão semeada é apagada e o
 * módulo volta ao que era, então roda quantas vezes for preciso.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { test, expect, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

const EVIDENCIA = path.join(process.cwd(), "evidence", "banco-externo-painel-das-fontes");
function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

const sufixo = randomUUID().slice(0, 6);
const NOME_DA_CONEXAO = `Conexão E2E fontes ${sufixo}`;
const CHAVE_MODULO = "MODULO_BANCO_EXTERNO";

test.use({ viewport: { width: 1600, height: 900 } });
test.describe.configure({ timeout: 300_000 });

/** O formato `TabelaExterna` que o `GET catalog` devolveria, com 2 tabelas. */
const CATALOGO = [
  {
    schema: "public",
    nome: "pedidos",
    tipo: "tabela",
    colunas: [
      { nome: "id", tipo: "text", nulavel: true, posicao: 1 },
      { nome: "telefone", tipo: "text", nulavel: true, posicao: 2 },
      { nome: "total", tipo: "text", nulavel: true, posicao: 3 },
    ],
    chavePrimaria: ["id"],
    estimativaLinhas: 10,
  },
  {
    schema: "public",
    nome: "wp_users",
    tipo: "tabela",
    colunas: [
      { nome: "id", tipo: "text", nulavel: true, posicao: 1 },
      { nome: "user_pass", tipo: "text", nulavel: true, posicao: 2 },
    ],
    chavePrimaria: ["id"],
    estimativaLinhas: 10,
  },
];

let creds: CredsE2E;
let conexaoId: string;
let moduloAntes: string | null = null;

/** Quantas vezes o painel chamou o catálogo completo (só o admin pode). */
const chamadas = { catalog: 0 };

/** Simula SÓ o catálogo na rede, antes do `goto`. Conta as chamadas. */
async function simularCatalogo(page: Page): Promise<void> {
  await page.route("**/api/v1/external-db/connections/*/catalog", async (rota) => {
    chamadas.catalog += 1;
    await rota.fulfill({ json: { data: { tabelas: CATALOGO } } });
  });
  await page.route("**/api/v1/external-db/connections/*/schemas", async (rota) => {
    await rota.fulfill({ json: { data: { tabelas: CATALOGO } } });
  });
}

function urlDoPainel(): string {
  return `/app/integracao-dados/${conexaoId}?fontes=1`;
}

async function lerLinhaDoBanco(): Promise<{ source_mode: string; sources: unknown[] }> {
  const { data, error } = await db
    .from("external_db_connections")
    .select("source_mode, sources")
    .eq("id", conexaoId)
    .single();
  if (error ?? !data) throw error ?? new Error("conexão semeada sumiu do banco");
  return data as { source_mode: string; sources: unknown[] };
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

  const org = await db.from("organizations").select("id").eq("slug", "e2e-test-org").single();
  if (org.error ?? !org.data) throw org.error ?? new Error('organização "e2e-test-org" não encontrada');
  const criada = await db
    .from("external_db_connections")
    .insert({
      organization_id: (org.data as { id: string }).id,
      label: NOME_DA_CONEXAO,
      host: "banco.exemplo.invalid",
      port: 5432,
      database_name: "e2e",
      username: "leitor",
      password_encrypted: "\\x00",
      password_iv: "\\x00",
      password_tag: "\\x00",
      source_mode: "list",
      sources: [],
      customer_key_column: "telefone",
      customer_key_kind: "phone",
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

test.describe("Painel — o que o assistente pode ver", () => {
  // Os casos dependem uns dos outros (o 4 lê o que o 3 salvou). Em `serial`, uma nova tentativa do CI refaz o grupo
  // inteiro, e o `beforeAll` cria a conexão do zero — sem isso a nova tentativa acharia o estado pela metade.
  test.describe.configure({ mode: "serial" });
  test("2. admin, primeira impressão: lista vazia mostra o banner e o selo", async ({ page }) => {
    await simularCatalogo(page);
    creds = await loginComoAdmin(page, creds);
    await page.goto(urlDoPainel());
    await expect(
      page.getByText("Falta escolher o que o assistente pode ler. Até lá, ele não enxerga nada deste banco."),
    ).toBeVisible();
    await expect(page.getByText("Nada liberado")).toBeVisible();
    await page.screenshot({ path: evidencia("01-vazio.png") });
  });

  test("3. marcar e salvar grava as colunas explícitas", async ({ page }) => {
    await simularCatalogo(page);
    creds = await loginComoAdmin(page, creds);
    await page.goto(urlDoPainel());
    await page.getByRole("checkbox", { name: "Liberar public.pedidos" }).click();
    await page.getByRole("button", { name: "Detalhes" }).click();
    const telefone = page.getByRole("checkbox", { name: "telefone" });
    await expect(telefone).toBeChecked();
    await expect(telefone).toBeDisabled();
    await page.getByPlaceholder("Ex.: pedidos dos clientes, com status e valor").fill("pedidos dos clientes");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Lista salva. O assistente já usa a nova lista.")).toBeVisible();
    await page.screenshot({ path: evidencia("02-marcada.png") });

    const linha = await lerLinhaDoBanco();
    expect(linha.source_mode).toBe("list");
    expect(linha.sources).toEqual([
      { schema: "public", tabela: "pedidos", colunas: ["id", "telefone", "total"], descricao: "pedidos dos clientes" },
    ]);
  });

  test("4. recarregar mantém o marcado e o explorador não encolhe", async ({ page }) => {
    await simularCatalogo(page);
    creds = await loginComoAdmin(page, creds);
    await page.goto(urlDoPainel());
    await expect(page.getByRole("checkbox", { name: "Liberar public.pedidos" })).toBeChecked();
    await expect(page.getByText("1 tabela liberada")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Liberar public.pedidos" })).toBeChecked();
    const caixa = await page.locator("aside").first().boundingBox();
    expect(caixa?.height ?? 0).toBeGreaterThanOrEqual(300);
  });

  test("5. modo tudo avisa forte e volta para a lista", async ({ page }) => {
    await simularCatalogo(page);
    creds = await loginComoAdmin(page, creds);
    await page.goto(urlDoPainel());
    await page.getByRole("radio", { name: "Tudo que o usuário do banco enxerga" }).click();
    await expect(
      page.getByText("O assistente enxerga todas as tabelas que o usuário do banco enxerga."),
    ).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Liberar public.pedidos" })).toHaveCount(0);
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Lista salva. O assistente já usa a nova lista.")).toBeVisible();
    await page.screenshot({ path: evidencia("03-modo-tudo.png") });
    expect((await lerLinhaDoBanco()).source_mode).toBe("all");

    await page.getByRole("radio", { name: "Só o que eu marcar (recomendado)" }).click();
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Lista salva. O assistente já usa a nova lista.")).toBeVisible();
    const volta = await lerLinhaDoBanco();
    expect(volta.source_mode).toBe("list");
    expect(volta.sources).toHaveLength(1);
  });

  test("6. quem só lê vê a lista e não edita nem chama o catálogo", async ({ page }) => {
    chamadas.catalog = 0;
    await simularCatalogo(page);
    await page.context().clearCookies();
    await page.goto("/login");
    await page.locator("#email").fill(creds.users.viewer!.email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/app/, { timeout: 30_000 });
    await page.goto(urlDoPainel());
    await expect(page.getByText("public.pedidos")).toBeVisible();
    await expect(page.getByText("pedidos dos clientes")).toBeVisible();
    await expect(page.locator("#fontes input[type=checkbox]")).toHaveCount(0);
    await expect(page.locator("#fontes").getByRole("button", { name: "Salvar" })).toHaveCount(0);
    expect(chamadas.catalog).toBe(0);
    await page.screenshot({ path: evidencia("04-somente-leitura.png") });
  });

  test("7. a lista de conexões mostra o resumo no cartão", async ({ page }) => {
    await simularCatalogo(page);
    creds = await loginComoAdmin(page, creds);
    await page.goto("/app/integracao-dados");
    const cartao = page.locator("div.p-4", { has: page.getByRole("link", { name: NOME_DA_CONEXAO }) });
    await expect(cartao.getByText("1 tabela liberada")).toBeVisible();
  });
});
