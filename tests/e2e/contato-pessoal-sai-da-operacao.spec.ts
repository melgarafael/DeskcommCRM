/**
 * CONTATO PESSOAL SAI DA OPERAÇÃO — marcar some, Pessoais acha, desmarcar volta.
 *
 * Prova PELA TELA (spec 21, fatia 3 — critérios 5 e 10 pela tela):
 * gerente marca o contato na ficha → a lista de Contatos deixa de mostrar →
 * o filtro "Pessoais" mostra com o selo → desmarcar na ficha → volta à lista
 * sem selo, com o mesmo nome (nada apagado).
 *
 * O esconderijo do inbox, o veto de envio e os 12 caminhos estão provados em
 * `tests/unit/contato-pessoal-*.test.ts` (o e2e do inbox exigiria canal
 * conectado com mensagens; aqui a superfície é a de Contatos, que é onde mora
 * o botão desmarcar). A API é conferida no meio do roteiro, como segunda régua.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

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

/** Único por execução: a lista é compartilhada entre execuções. */
const sufixo = `${process.pid}`.slice(-6);
const NOME = `Contato Pessoal ${sufixo}`;

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

async function criarContato(page: Page): Promise<string> {
  const criado = await page.request.post("/api/v1/contacts", {
    data: { display_name: NOME, source: "manual" },
  });
  expect(criado.status(), "não deu para criar o contato de teste").toBe(201);
  const corpo = (await criado.json()) as { data: { contact: { id: string } } };
  return corpo.data.contact.id;
}

test("marcar some da lista, Pessoais acha com selo, desmarcar volta sem selo", async ({ page }) => {
  await login(page);
  const contatoId = await criarContato(page);

  // Base: o contato novo aparece na lista.
  await page.goto("/app/contacts");
  await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 20_000 });

  // Marca PELA TELA, na ficha — com confirmação.
  await page.goto(`/app/contacts/${contatoId}`);
  await expect(page.getByTestId("marcar-pessoal")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("marcar-pessoal").click();
  const dialogo = page.getByRole("alertdialog");
  await expect(dialogo.getByText("Marcar este contato como pessoal?")).toBeVisible();
  await dialogo.getByRole("button", { name: "Marcar como pessoal" }).click();
  // Marcado: o botão virou desmarcar.
  await expect(page.getByTestId("desmarcar-pessoal")).toBeVisible({ timeout: 20_000 });

  // Segunda régua (API): padrão não lista; ?pessoais=true lista.
  const padrao = await page.request.get("/api/v1/contacts?limit=100");
  expect(padrao.status()).toBe(200);
  const listaPadrao = (await padrao.json()) as { data: Array<{ id: string }> };
  expect(listaPadrao.data.map((c) => c.id)).not.toContain(contatoId);
  const soPessoais = await page.request.get("/api/v1/contacts?limit=100&pessoais=true");
  expect(soPessoais.status()).toBe(200);
  const listaPessoal = (await soPessoais.json()) as { data: Array<{ id: string }> };
  expect(listaPessoal.data.map((c) => c.id)).toContain(contatoId);

  // Some da lista.
  await page.goto("/app/contacts");
  await expect(page.getByText(NOME)).toHaveCount(0, { timeout: 20_000 });

  // O filtro Pessoais acha, com o selo.
  await page.getByTestId("filtro-pessoais").click();
  await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Pessoal", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "evidence/spec-21/contato-pessoal-filtro-com-selo.png", fullPage: true });

  // Desmarca PELA TELA, na ficha.
  await page.getByText(NOME).first().click();
  await page.waitForURL(/\/app\/contacts\//, { timeout: 20_000 });
  await expect(page.getByTestId("desmarcar-pessoal")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("desmarcar-pessoal").click();
  await expect(page.getByTestId("marcar-pessoal")).toBeVisible({ timeout: 20_000 });

  // Volta à lista, sem selo e com o mesmo nome (nada apagado).
  await page.goto("/app/contacts");
  await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 20_000 });
  // `exact: true` de propósito: o botão do filtro se chama "Pessoais" e casa
  // com "Pessoal" por substring — sem exato, ele sozinho já quebra a contagem.
  await expect(page.getByText("Pessoal", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "evidence/spec-21/contato-pessoal-volta-sem-selo.png", fullPage: true });
});
