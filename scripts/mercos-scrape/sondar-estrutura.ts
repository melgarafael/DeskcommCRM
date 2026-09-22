/** Sonda profunda: controles de paginação (produtos) e estrutura (clientes). */
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
      const clicaveis = [...document.querySelectorAll("button, a, [role='button']")]
        .map((b) => (b.textContent?.trim().slice(0, 50) ?? "").replace(/\s+/g, " "))
        .filter((t) => t && /pr[oó]xim|anterior|p[aá]gina|mais|carregar|filtr|buscar|exibir|ver|lista|grade|^\d+$|»|«/i.test(t));
      return {
        url: location.href,
        clicaveis: [...new Set(clicaveis)].slice(0, 40),
        AbasOuCards: [...document.querySelectorAll("[role='tab'], .tab, .card h3, .card h4, h2")]
          .map((e) => e.textContent?.trim().slice(0, 80) ?? "")
          .filter(Boolean)
          .slice(0, 30),
        temGrade: document.querySelectorAll("table").length,
        scrollHeight: document.body.scrollHeight,
      };
    });
    await page.screenshot({ path: join(SAIDA, `sonda-${nome}.png`), fullPage: false });
  }

  writeFileSync(join(SAIDA, "sonda-estrutura.json"), JSON.stringify(out, null, 2), "utf8");
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
