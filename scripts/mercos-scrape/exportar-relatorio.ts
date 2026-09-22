/**
 * Exporta UM relatório do Mercos com período amplo (fase 4b).
 *
 * Caminho: Indicadores > aba RELATÓRIOS > clica o relatório > preenche
 * Data inicial/final > Aplicar > baixa o Excel. O Excel do Mercos é .xls
 * (BIFF) com título + filtros + grade a partir da linha ~9.
 *
 * Uso:
 *   pnpm exec tsx scripts/mercos-scrape/exportar-relatorio.ts "Produtos por pedido" 01/01/2022 05/09/2026
 * Saída: %TEMP%/opencode/mercos/exp-<slug>.xls (+ .json com resumo)
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

async function preencherData(page: Page, rotulo: RegExp, valor: string): Promise<boolean> {
  // Tenta label > input, depois inputs de data/texto visíveis próximos ao texto.
  const porLabel = page.getByLabel(rotulo).first();
  if ((await porLabel.count()) > 0) {
    await porLabel.click().catch(() => {});
    await porLabel.fill(valor).catch(() => {});
    return true;
  }
  const ok = await page.evaluate(
    ({ rx, v }) => {
      const re = new RegExp(rx, "i");
      const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')] as HTMLInputElement[];
      // Acha pelo texto vizinho (label, placeholder ou container).
      for (const inp of inputs) {
        const ctx = `${inp.placeholder} ${inp.name} ${inp.id} ${inp.parentElement?.innerText?.slice(0, 80) ?? ""}`;
        if (re.test(ctx) && inp.offsetParent !== null) {
          inp.focus();
          inp.value = "";
          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, v);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    },
    { rx: rotulo.source, v: valor },
  );
  return ok;
}

async function main(): Promise<void> {
  const nome = process.argv[2] ?? "Produtos por pedido";
  const ini = process.argv[3] ?? "01/01/2022";
  const fim = process.argv[4] ?? "05/09/2026";
  mkdirSync(SAIDA, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();

  await page.goto("https://app.mercos.com/338282/indicadores/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);
  if (nome.startsWith("https://")) {
    await page.goto(nome, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6000);
  } else {
    await page.getByText(/relatórios/i).first().click({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const link = page.getByRole("link", { name: new RegExp(nome, "i") }).first();
    if ((await link.count()) === 0) throw new Error(`Relatório "${nome}" não achado na aba RELATÓRIOS.`);
    await link.click();
    await page.waitForTimeout(6000);
  }

  const okIni = await preencherData(page, /data inicial|de:|período.*in/i, ini);
  const okFim = await preencherData(page, /data final|at[eé]:|período.*fi/i, fim);
  const aplicar = page.getByRole("button", { name: /aplicar|filtrar|buscar|gerar/i }).first();
  if ((await aplicar.count()) > 0) {
    await aplicar.click();
    await page.waitForTimeout(8000);
  }

  const slug = nome.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const botao = page
    .getByRole("button", { name: /excel|xls|exportar/i })
    .or(page.locator('a[href*=".xls"], a[href*="export"]'))
    .first();
  let arquivo: string | null = null;
  if ((await botao.count()) > 0) {
    // Fecha popups/overlays que interceptam o clique (ex: banner "X clientes
    // podem ter interesse em comprar online").
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1500);
    const fechar = page.getByRole("button", { name: /close|fechar/i }).first();
    if ((await fechar.count()) > 0) await fechar.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
    await botao.scrollIntoViewIfNeeded().catch(() => {});
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      botao.click({ force: true }),
    ]);
    arquivo = join(SAIDA, `exp-${slug}.xls`);
    await download.saveAs(arquivo);
  }
  const tabelas = await page.evaluate(() => document.querySelectorAll("table").length);
  writeFileSync(
    join(SAIDA, `exp-${slug}.json`),
    JSON.stringify({ nome, ini, fim, okIni, okFim, arquivo, tabelas, url: page.url() }, null, 2),
    "utf8",
  );
  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`OK -> ${arquivo ?? "sem download"} (filtros ini=${okIni} fim=${okFim})`);
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
