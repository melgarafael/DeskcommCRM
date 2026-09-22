/** Sonda a estrutura de filtros da página de um relatório (debug). */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

async function main(): Promise<void> {
  const nome = process.argv[2] ?? "Produtos por pedido";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();
  await page.goto("https://app.mercos.com/338282/indicadores/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.getByText(/relatórios/i).first().click({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.getByRole("link", { name: new RegExp(nome, "i") }).first().click();
  await page.waitForTimeout(8000);
  // Abre o painel de filtros (botão/link com texto Filtro) e despeja de novo.
  const gatilho = page
    .getByRole("button", { name: /filtro/i })
    .or(page.getByRole("link", { name: /filtro/i }))
    .or(page.locator("button:has-text('Filtros'), a:has-text('Filtros')"))
    .first();
  if ((await gatilho.count()) > 0) {
    await gatilho.click().catch(() => {});
    await page.waitForTimeout(4000);
  }
  const dump = await page.evaluate(() => ({
    url: location.href,
    inputs: [...document.querySelectorAll("input")]
      .map((i) => ({
        type: (i as HTMLInputElement).type,
        name: (i as HTMLInputElement).name,
        id: i.id,
        ph: (i as HTMLInputElement).placeholder,
        val: (i as HTMLInputElement).value,
        vis: (i as HTMLElement).offsetParent !== null,
      }))
      .slice(0, 30),
    buttons: [...document.querySelectorAll("button")]
      .map((b) => b.textContent?.trim().slice(0, 40) ?? "")
      .filter(Boolean)
      .slice(0, 30),
  }));
  writeFileSync(join(SAIDA, "sonda-filtro.json"), JSON.stringify(dump, null, 2), "utf8");
  await page.screenshot({ path: join(SAIDA, "sonda-filtro.png") });
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
