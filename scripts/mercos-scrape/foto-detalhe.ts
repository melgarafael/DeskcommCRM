/** Foto full-page de um pedido detalhado (referência de layout). */
import { chromium } from "@playwright/test";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos", "auditoria");

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto("https://app.mercos.com/338282/pedidos/165512937/detalhar/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(SAIDA, "pedido-detalhe.png"), fullPage: true });
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
