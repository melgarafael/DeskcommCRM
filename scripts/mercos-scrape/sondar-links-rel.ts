/** Despeja links da aba RELATÓRIOS com URLs (acha o relatório de clientes). */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();
  await page.goto("https://app.mercos.com/338282/indicadores/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);
  await page.getByText(/relatórios/i).first().click({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const links = await page.evaluate(() =>
    [...new Set(
      [...document.querySelectorAll("main a, section a")]
        .map((a) => `${(a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80)} -> ${(a as HTMLAnchorElement).href}`),
    )].slice(0, 60),
  );
  writeFileSync(join(SAIDA, "sonda-relatorios-links.json"), JSON.stringify(links, null, 2), "utf8");
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
