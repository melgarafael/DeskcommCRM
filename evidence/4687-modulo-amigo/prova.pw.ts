/**
 * PROVA DE TELA do #4687 (módulo opcional `amigo`) — o caminho de um leigo, numa
 * instalação fresca estilo VPS (baseline + bootstrap-owner, next build + next start).
 *
 * 1. Sem o módulo: a tela do Amigo responde 404 e o hub do CRM não tem a porta.
 * 2. Administração › Módulos: instalar "Amigo (sistema de clínicas)".
 * 3. Hub do CRM → porta "Amigo" → tela do Amigo.
 * 4. Colar o token, testar, escolher a unidade, salvar → "Token salvo •••• <4 últimos>".
 * 5. O token não volta: busca no DOM inteiro (HTML + valor de todo input) e em toda
 *    resposta das rotas do Amigo, antes e depois de recarregar.
 * 6. Desligar o módulo (a instalação não tem botão de desinstalar: o estado vai a
 *    `suspenso` no banco, como o update.sh faz quando a provisionadora falha) → a
 *    tela volta a 404 e a porta some do hub.
 *
 * O receptor de mentira (`receptor.mjs`) grava o que chegou em `recebido.jsonl`.
 */
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const TOKEN = process.env.AMIGO_TOKEN_FICTICIO ?? "";
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "dono@qa.local";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? "";
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const DIR = "evidence/4687-modulo-amigo";
const PORTA_DO_HUB = 'a[href="/app/integrations/amigo"]';

async function sql(comando: string): Promise<string> {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const r = await db.query(comando);
    const linha = r.rows[0] as Record<string, unknown> | undefined;
    return linha ? String(Object.values(linha)[0]) : "";
  } finally {
    await db.end();
  }
}

async function foto(page: Page, nome: string) {
  await page.screenshot({ path: `${DIR}/${nome}.png`, fullPage: true });
}

async function tokenAusenteDoDom(page: Page) {
  expect(await page.content()).not.toContain(TOKEN);
  const valores = await page.evaluate(() =>
    [...document.querySelectorAll("input, textarea")].map((e) => (e as HTMLInputElement).value),
  );
  expect(valores.join("\n")).not.toContain(TOKEN);
}

test("módulo amigo: instalar, abrir pela porta do hub, salvar o token sem que ele volte, desligar e sumir", async ({ page }) => {
  expect(TOKEN.length).toBeGreaterThan(8);

  // Toda resposta das rotas do Amigo, para provar que o token não volta por elas.
  const respostas: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/v1/integrations/amigo")) respostas.push(await r.text().catch(() => ""));
  });

  await page.goto("/login");
  await page.locator("#email").fill(OWNER_EMAIL);
  await page.locator("#password").fill(OWNER_PASSWORD);
  await page.locator("#password").press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });

  // 1. sem o módulo
  const antes = await page.goto("/app/integrations/amigo");
  // A página já começou a ser enviada quando o notFound() dispara: o Next devolve 200
  // com a tela de 404. O que o leigo vê é a tela, e é ela que se confere.
  expect(antes).not.toBeNull();
  await expect(page.getByRole("heading", { name: /404/ })).toBeVisible();
  await foto(page, "01-sem-modulo-tela-404");
  await page.goto("/app/crm");
  await expect(page.locator(PORTA_DO_HUB)).toHaveCount(0);
  await foto(page, "02-sem-modulo-hub-sem-porta");

  // 2. Administração › Módulos
  await page.goto("/admin/modulos");
  const cartao = page.getByTestId("modulo-amigo");
  await expect(cartao).toBeVisible();
  await foto(page, "03-modulos-antes-de-instalar");
  await page.getByTestId("instalar-amigo").click();
  await expect(cartao.getByText("Instalado")).toBeVisible({ timeout: 60_000 });
  await foto(page, "04-modulo-instalado");
  expect(await sql("select estado from public.modulos_instalados where modulo='amigo'")).toBe("ativo");

  // 3. hub do CRM → porta
  await page.goto("/app/crm");
  await expect(page.locator(PORTA_DO_HUB)).toHaveCount(1);
  await foto(page, "05-hub-com-a-porta");
  await page.locator(PORTA_DO_HUB).first().click();
  await page.waitForURL("**/app/integrations/amigo**");
  await expect(page.getByText("Conecte sua clínica quando estiver pronto")).toBeVisible();
  await foto(page, "06-tela-amigo-sem-conexao");

  // 4. token, testar, unidade, salvar
  await page.getByPlaceholder("Cole o token de acesso").fill(TOKEN);
  await page.getByRole("button", { name: "Testar conexão" }).click();
  await expect(page.getByText("Conexão validada. Confira a unidade antes de salvar.")).toBeVisible();
  await page.getByLabel("Unidade padrão").selectOption("7");
  await foto(page, "07-token-testado");
  await page.getByRole("button", { name: "Salvar configuração" }).click();
  await expect(page.getByText("Token salvo")).toBeVisible();
  await expect(page.getByText(`•••• ${TOKEN.slice(-4)}`)).toBeVisible();
  await foto(page, "08-conectado-token-salvo");

  // 5. o token não volta — antes e depois de recarregar
  await tokenAusenteDoDom(page);
  await page.reload();
  await expect(page.getByText("Token salvo")).toBeVisible();
  await tokenAusenteDoDom(page);
  await foto(page, "09-conectado-apos-recarregar");
  expect(respostas.length).toBeGreaterThan(0);
  for (const corpo of respostas) expect(corpo).not.toContain(TOKEN);
  // No banco, só o cifrado: o texto do token não está em nenhuma coluna das tabelas do módulo.
  expect(await sql(`select count(*) from public.amigo_credentials where ciphertext like '%${TOKEN}%'`)).toBe("0");
  expect(await sql(`select count(*) from public.amigo_connections c where to_jsonb(c)::text like '%${TOKEN}%'`)).toBe("0");

  // 6. desligar → some
  await sql("update public.modulos_instalados set estado='suspenso', motivo_suspensao='prova de tela #4687' where modulo='amigo'");
  const depois = await page.goto("/app/integrations/amigo");
  // A página já começou a ser enviada quando o notFound() dispara: o Next devolve 200
  // com a tela de 404. O que o leigo vê é a tela, e é ela que se confere.
  expect(depois).not.toBeNull();
  await expect(page.getByRole("heading", { name: /404/ })).toBeVisible();
  await foto(page, "10-desligado-tela-404");
  await page.goto("/app/crm");
  await expect(page.locator(PORTA_DO_HUB)).toHaveCount(0);
  await foto(page, "11-desligado-hub-sem-porta");
  const api = await page.request.get("/api/v1/integrations/amigo");
  expect(api.status()).toBe(404);
});
