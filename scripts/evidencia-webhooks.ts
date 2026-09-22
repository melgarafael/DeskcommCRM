/**
 * Fotografa as telas desta entrega para a evidência do PR.
 *
 * Não é teste: é o instrumento que produz as imagens que a doutrina de QA
 * Visual cobra (`evidence/`, que é versionado — `.superpowers/evidence/` é
 * gitignored). Roda contra o app já de pé, com o banco já semeado.
 *
 * Run: E2E_PORT=3021 npx tsx scripts/evidencia-webhooks.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { chromium } from "@playwright/test";

const APP = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const DESTINO = path.join(process.cwd(), "evidence", "webhooks-historico-e-ia");

async function main(): Promise<void> {
  fs.mkdirSync(DESTINO, { recursive: true });
  const creds = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as {
    password: string;
    users: Record<string, { email: string }>;
  };

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`${APP}/login`);
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);

  await page.goto(`${APP}/app/webhooks`);

  await page.getByRole("tab", { name: "Leads recebidos" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DESTINO, "01-leads-recebidos.png"), fullPage: false });

  // O painel de uma captação: dados, hora, origem, IP.
  const primeira = page.getByRole("row").nth(1).getByRole("button").first();
  if (await primeira.count()) {
    await primeira.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(DESTINO, "02-detalhe-da-captacao.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  await page.getByRole("tab", { name: "Atividade" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(DESTINO, "03-atividade-diz-falhou.png") });

  // O editor com a ação nova de IA.
  await page.getByRole("tab", { name: "Automações" }).click();
  await page.getByRole("button", { name: /Nova automação/ }).click();
  const editor = page.getByRole("dialog");
  await editor.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /contato novo \(webhook\)/i }).click();
  await editor.getByRole("combobox").filter({ hasText: "Adicionar ação" }).click();
  await page.getByRole("option", { name: "Mensagem escrita pela IA" }).click();
  await editor
    .locator("#ai-instruction")
    .fill(
      "Agradeça citando o segmento que a pessoa informou, mostre em uma frase como resolvemos a dificuldade que ela descreveu, e pergunte qual o melhor horário para conversar.",
    );
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(DESTINO, "04-acao-mensagem-pela-ia.png") });

  await browser.close();
  console.log(`evidência em ${DESTINO}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
