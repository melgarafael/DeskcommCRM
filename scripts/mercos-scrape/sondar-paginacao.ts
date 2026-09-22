/** Sonda paginação das telas de Produtos e Clientes (descoberta rápida). */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();
  const out: Record<string, unknown> = {};

  for (const [nome, url] of [
    ["produtos", "https://app.mercos.com/industria/338282/produtos/"],
    ["clientes", "https://app.mercos.com/338282/clientes/"],
  ] as [string, string][]) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(5000);
    out[nome] = await page.evaluate(() => {
      const hrefs = [...new Set(
        [...document.querySelectorAll("a")]
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((h) => /ultimo_id|pagina|page=/.test(h)),
      )].slice(0, 10);
      const tabelas = [...document.querySelectorAll("table")].map((t) => ({
        cab: [...t.querySelectorAll("thead th")].map((x) => x.textContent?.trim() ?? ""),
        n: t.querySelectorAll("tbody tr").length,
      }));
      const linhas = [...document.body.innerText.split("\n")]
        .map((l) => l.trim())
        .filter((l) => /\d/.test(l) && /exibindo|total|registros?|p[aá]gina|de \d+/i.test(l))
        .slice(0, 8);
      return { url: location.href, hrefs, tabelas, linhas };
    });
  }

  writeFileSync(join(SAIDA, "sonda-paginacao.json"), JSON.stringify(out, null, 2), "utf8");
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
