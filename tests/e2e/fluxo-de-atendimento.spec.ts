/**
 * Fluxos de atendimento — prova de tela da função nova.
 *
 * Percorre a jornada como o dono a faria: entra (manager), abre a tela, lê o
 * guia "Como usar", cria um fluxo de atendimento e confere que o editor abre na
 * ROTA CERTA (`/app/ai/atendimento/<id>`, não Follow-ups) com os nós
 * **Pergunta** e **Skill** na paleta — que é o que esta função acrescenta ao
 * construtor compartilhado.
 *
 * Não dirige o runtime (mensagem real): isso é o teste ao vivo. Aqui a prova é
 * de UI/front-end, que é o que a doutrina de QA Visual exige com evidência.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const needsSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsSeed()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.describe("fluxos de atendimento — tela, guia e editor", () => {
  test("manager cria um fluxo, vê o guia e o editor com Pergunta e Skill", async ({ page }) => {
    await login(page, creds.users.manager!.email);

    await page.goto("/app/ai/atendimento");
    await expect(page.getByRole("heading", { name: "Fluxos de atendimento" })).toBeVisible();
    // O guia para leigos fica na própria tela.
    await expect(page.getByTestId("como-usar")).toBeVisible();
    await page.screenshot({ path: "test-results/fluxo-atendimento-01-lista.png", fullPage: true });

    const nome = `E2E Atendimento ${Date.now()}`;
    await page.getByRole("button", { name: "Novo fluxo de atendimento" }).click();
    await page.locator("#flow-name").fill(nome);
    await page.getByRole("button", { name: "Criar fluxo" }).click();

    // Aparece na lista da superfície certa.
    const cartao = page.locator("a", { hasText: nome }).first();
    await expect(cartao).toBeVisible({ timeout: 10_000 });

    // Abre no editor de ATENDIMENTO (não em /followups).
    await cartao.click();
    await page.waitForURL(/\/app\/ai\/atendimento\/.+/);
    await expect(page.getByTestId("flow-canvas")).toBeVisible();

    // A paleta tem os nós novos desta função.
    await expect(page.getByText("Pergunta", { exact: true })).toBeVisible();
    await expect(page.getByText("Skill", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/fluxo-atendimento-02-editor.png", fullPage: true });
  });
});
