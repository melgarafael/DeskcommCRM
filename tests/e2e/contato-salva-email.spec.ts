/**
 * SALVAR O E-MAIL DE UM CONTATO — o defeito relatado, provado PELA TELA.
 *
 * O relato foi "não registra o número e email dele". A causa não era campo
 * faltando: `patchContactHandler` escrevia em `contacts.email_normalized`, que é
 * `GENERATED ALWAYS AS (lower(trim(email))) STORED`. O Postgres recusa qualquer
 * atribuição a coluna gerada (428C9) e **aborta o UPDATE inteiro** — então o
 * PATCH voltava 500 e nem o e-mail nem os outros campos do mesmo formulário
 * eram salvos.
 *
 * O invariante `colunas-geradas-nao-sao-escritas.test.ts` guarda a CLASSE do
 * defeito no código. Este spec guarda o que o usuário faz: abrir o contato,
 * clicar em Editar, digitar o e-mail e ver que ficou.
 *
 * Prova junto o que se perdia por tabela: o `email_normalized` continua correto
 * DEPOIS do conserto — o banco deriva a coluna sozinho, era só não escrever nela.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = lerCreds();

/** Único por execução: o banco de e2e é compartilhado, e `contacts.email` tem índice único por org. */
const sufixo = `${process.pid}`.slice(-6);
const NOME = `Contato Email ${sufixo}`;
const EMAIL = `contato.email.${sufixo}@exemplo.com.br`;

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test("o e-mail digitado na tela do contato fica salvo", async ({ page }) => {
  await login(page);

  // Cria o contato pela API autenticada (a criação não é o que está sob teste;
  // o que está sob teste é o PATCH, e ele é exercitado pela TELA logo abaixo).
  const criado = await page.request.post("/api/v1/contacts", {
    data: { display_name: NOME, source: "manual" },
  });
  expect(criado.status(), "não deu para criar o contato de teste").toBe(201);
  // ⚠️ O corpo é `{ data: { contact: {...} } }`, não `{ data: {...} }`. Ler
  // `data.id` devolve `undefined`, a navegação vira `/app/contacts/undefined` e
  // a tela dá 404 — que se lê como bug do produto e é erro do teste.
  const corpo = (await criado.json()) as { data: { contact: { id: string } } };
  const contatoId = corpo.data.contact.id;

  await page.goto(`/app/contacts/${contatoId}`);
  await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 20_000 });

  // Controle: antes de salvar, o campo está vazio na ficha. Sem esta linha, um
  // e-mail que já estivesse lá faria a asserção final passar sem que o PATCH
  // tivesse funcionado.
  await expect(page.getByText(EMAIL)).toHaveCount(0);

  await page.getByRole("button", { name: /editar/i }).first().click();
  const campo = page.locator("#ec-email");
  await campo.waitFor({ state: "visible", timeout: 10_000 });
  await campo.fill(EMAIL);
  await page.getByRole("button", { name: /^salvar$/i }).click();

  // O defeito aparecia AQUI: o PATCH voltava 500 e a tela não mudava.
  await expect(
    page.getByText(EMAIL).first(),
    "o e-mail salvo tem de aparecer na ficha do contato",
  ).toBeVisible({ timeout: 20_000 });

  // E persiste — recarregando, veio do banco, não do estado do formulário.
  await page.reload();
  await expect(page.getByText(EMAIL).first()).toBeVisible({ timeout: 20_000 });

  // A derivada que o código escrevia à mão: o banco a produziu sozinho.
  const lido = await page.request.get(`/api/v1/contacts/${contatoId}`);
  expect(lido.status()).toBe(200);
  // ⚠️ O POST devolve `{data:{contact:{…}}}` e o GET devolve `{data:{…}}` — os
  // dois contratos convivem hoje na mesma rota. Aceitar as duas formas aqui é
  // deliberado: uniformizá-los é mudança de contrato público, e não é carona
  // deste conserto. Registrado no handoff.
  const cru = (await lido.json()) as {
    data: { contact?: { email: string; email_normalized: string } } & {
      email?: string;
      email_normalized?: string;
    };
  };
  const ficha = cru.data.contact ?? (cru.data as { email: string; email_normalized: string });
  expect(ficha.email).toBe(EMAIL);
  expect(
    ficha.email_normalized,
    "o Postgres deriva a coluna — era só não escrever nela",
  ).toBe(EMAIL.toLowerCase());

  await page.screenshot({ path: "evidence/spec-17/contato-com-email-salvo.png", fullPage: true });
});
