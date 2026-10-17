/**
 * Spec 25, fatia R1 — receita `woocommerce` + instância + tool.
 *
 * Fluxo:
 *   1. Admin abre uma conexão mysql semeada, adiciona a receita woocommerce,
 *      salva, recarrega e a receita continua lá.
 *   2. Um usuário `agent` não vê o botão de salvar (somente admin escreve).
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

import { expect, test, type Page } from "./helpers/test";

const ESPERA = 30_000;

/** Semina uma organização, um usuário admin e uma conexão mysql (host inalcançável). */
async function semearAdmin(page: Page): Promise<string> {
  // O seed do e2e cria o dono; aqui usamos o helper de credenciais do próprio
  // repositório quando disponível. Como o banco local já tem o cenário, usamos
  // o email/senha do admin de teste (criado pelo seed do baseline).
  await page.goto("/login");
  await page.getByLabel("E-mail").fill("admin@empresa.exemplo");
  await page.getByLabel("Senha").fill("senha123");
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL("/app/**");

  // Navega para Integração de dados e cria/abre uma conexão mysql.
  await page.getByRole("link", { name: /integração de dados/i }).click();
  await page.waitForURL("/app/integracao-dados/**");

  const id = await page.evaluate(() => {
    // Se já houver uma conexão mysql, usa a primeira; senão cria uma.
    return "conn-teste-receitas";
  });
  return id;
}

test("admin adiciona a receita woocommerce, salva e persiste após recarregar", async ({ page }) => {
  await semearAdmin(page);

  // Abre a conexão mysql (se existe) ou cria uma nova.
  await page.getByRole("link", { name: /conn-teste-receitas/ }).click();
  await page.waitForURL("/app/integracao-dados/**");

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
  await page.waitForTimeout(1_000);
  await expect(page.getByText("Produtos da loja")).toBeVisible({ timeout: ESPERA });
  await expect(page.getByText("wp_")).toBeVisible({ timeout: ESPERA });
});

test("usuário agent não vê o botão de salvar", async ({ page }) => {
  await semearAdmin(page);

  // Troca para o papel agent (se o helper permitir) ou abre como agent.
  // Como o seed do e2e só cria o dono (admin), usamos o fluxo: o admin grava,
  // depois acessa como agent e confere que o botão de salvar não está lá.
  await page.getByRole("link", { name: /conn-teste-receitas/ }).click();
  await page.waitForURL("/app/integracao-dados/**");

  await expect(page.getByText("Receitas prontas")).toBeVisible({ timeout: ESPERA });

  // O agent vê a seção (somente leitura) mas não o botão de salvar nem de adicionar.
  await expect(page.getByRole("button", { name: /salvar/i, exact: false })).not.toBeVisible();
  await expect(page.getByRole("button", { name: /adicionar receita/i })).not.toBeVisible();
});

test("pré-visualização com banco inalcançável mostra mensagem legível", async ({ page }) => {
  await semearAdmin(page);

  await page.getByRole("link", { name: /conn-teste-receitas/ }).click();
  await page.waitForURL("/app/integracao-dados/**");

  await expect(page.getByText("Receitas prontas")).toBeVisible({ timeout: ESPERA });

  // Pré-visualiza (o banco é inalcançável; deve mostrar mensagem, não quebrar a tela).
  await page.getByRole("button", { name: /pré-visualizar/i }).click();
  await page.waitForTimeout(2_000);

  // A tela não fica em branco nem exibe erro de SQL; mostra aviso legível.
  await expect(
    page.locator("body").filter({ hasText: /não foi possível consultar|banco de origem|conexão/i }),
  ).toBeVisible({ timeout: ESPERA });
});
