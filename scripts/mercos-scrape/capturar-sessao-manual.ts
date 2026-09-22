/**
 * Captura MANUAL da sessão do Mercos — ZERO tentativas automáticas de login.
 *
 * Fluxo: abre o navegador COM JANELA, VOCÊ faz o login (resolve o reCAPTCHA
 * com calma, sem pressa de timeout), depois volta no terminal e aperta ENTER.
 * O script só SALVA a sessão em `.auth/mercos.json` para o extrator usar.
 * Nenhuma senha é digitada ou armazenada pelo script.
 *
 * Uso (PowerShell, na pasta DeskcommCRM):
 *   pnpm exec playwright install chromium
 *   pnpm exec tsx scripts/mercos-scrape/capturar-sessao-manual.ts
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");

function esperarEnter(msg: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(msg, () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await page.goto("https://app.mercos.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });

  await esperarEnter(
    "Navegador aberto. Faça o login MANUALMENTE (resolva o captcha), espere a tela inicial carregar e aperte ENTER aqui...",
  );

  mkdirSync(dirname(SESSAO), { recursive: true });
  await context.storageState({ path: SESSAO });
  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`Sessão salva em ${SESSAO}. Rode o extrator: pnpm exec tsx scripts/mercos-scrape/extrair-mercos.ts`);
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
