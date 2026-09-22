/** Localiza e aciona o Exportar clientes em Excel (fase 5b). */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

async function main(): Promise<void> {
  mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();

  await page.goto("https://app.mercos.com/338282/clientes/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5000);

  const mapa = await page.evaluate(() => ({
    botoes: [...document.querySelectorAll("button")]
      .map((b) => (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60))
      .filter(Boolean)
      .slice(0, 40),
    links: [...document.querySelectorAll("a")]
      .map((a) => `${(a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60)} -> ${(a as HTMLAnchorElement).href.slice(0, 120)}`)
      .filter((t) => /export|excel|import|lista|relat/i.test(t))
      .slice(0, 30),
  }));
  writeFileSync(join(SAIDA, "sonda-export-clientes.json"), JSON.stringify(mapa, null, 2), "utf8");
  await page.screenshot({ path: join(SAIDA, "sonda-export-clientes.png") });

  // Tenta: botão Exportar/Excel direto na tela de clientes.
  const exp = page
    .getByRole("button", { name: /exportar|excel/i })
    .or(page.getByRole("link", { name: /exportar|excel/i }))
    .first();
  if ((await exp.count()) > 0) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 120_000 }),
        exp.click(),
      ]);
      const destino = join(SAIDA, "exp-clientes.xls");
      await download.saveAs(destino);
      // eslint-disable-next-line no-console
      console.log(`OK download -> ${destino}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`botão achado mas sem download: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log("sem botão export na tela; ver sonda-export-clientes.json/png");
  }
  await browser.close();
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
