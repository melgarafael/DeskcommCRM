/** Baixa o PDF de um pedido no Mercos (botão Visualizar). */
import { chromium } from "@playwright/test";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos", "auditoria");

async function main(): Promise<void> {
  const id = process.argv[2] ?? "165512937";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`https://app.mercos.com/338282/pedidos/${id}/detalhar/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(SAIDA, "pdf-antes-clique.png") });
  const link = page.locator("a", { hasText: /visualizar/i }).first();
  if ((await link.count()) === 0) {
    // eslint-disable-next-line no-console
    console.log("sem link Visualizar (sessão expirada?)");
    await browser.close();
    return;
  }
  await link.click({ timeout: 15000 });
  await page.waitForTimeout(5000);
  // Rola o modal até o fim para capturar totais/condição/observações.
  await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]') || document.body;
    modal.scrollTo?.(0, 99999);
    document.querySelectorAll("[role='dialog'] *").forEach(() => undefined);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SAIDA, "pdf-modal-fim.png") });
  // Baixa o PDF oficial.
  const dl = page.getByRole("button", { name: /download pdf/i }).first();
  if ((await dl.count()) > 0) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        dl.click(),
      ]);
      await download.saveAs(join(SAIDA, "pedido-mercos.pdf"));
      // eslint-disable-next-line no-console
      console.log("OK download PDF");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log("sem download:", e instanceof Error ? e.message.slice(0, 120) : e);
    }
  }
  await browser.close();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
