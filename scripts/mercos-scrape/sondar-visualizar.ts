/** Sonda os botões de ação do detalhe (Visualizar/Enviar). */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos", "auditoria");

async function main(): Promise<void> {
  const id = process.argv[2] ?? "165512937";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();
  await page.goto(`https://app.mercos.com/338282/pedidos/${id}/detalhar/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6000);
  const dump = await page.evaluate(() => {
    const els = [...document.querySelectorAll("a, button")].filter((e) =>
      /visualizar|imprimir|pdf|email|whatsapp|exibir|download/i.test((e.textContent || "").trim()),
    );
    return els.slice(0, 20).map((e) => ({
      tag: e.tagName,
      texto: (e.textContent || "").trim().slice(0, 60),
      href: (e as HTMLAnchorElement).href || null,
    }));
  });
  writeFileSync(join(SAIDA, "sonda-visualizar.json"), JSON.stringify(dump, null, 2), "utf8");
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
