/**
 * Extração do Mercos com sessão salva por `login-mercos.ts`.
 *
 * Estratégia (medida na ajuda oficial, ajuda.mercos.com):
 * 1. Cada relatório mora em menu lateral "Indicadores" > aba "Relatórios"
 *    (seções Vendas / Produtos / Clientes / Comissionamento / Faturamento).
 * 2. Quase todo relatório tem botão de download Excel/PDF — baixar o Excel
 *    é 10x mais fiel que raspar tabela HTML. Tabela HTML é fallback.
 * 3. `indicadores-mapa.json` registra TUDO que existe lá (nome do relatório,
 *    seção, filtros, colunas) — é a matéria-prima do gap analysis e do
 *    dashboard "estilo Indicadores" no nosso sistema.
 *
 * Uso:
 *   pnpm exec tsx scripts/mercos-scrape/extrair-mercos.ts [pasta-saida]
 * Saída padrão: %TEMP%/opencode/mercos (fora do repo — dado real não commita).
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = process.argv[2] ?? join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

/** Relatórios confirmados na base de conhecimento do Mercos (2026-09-05). */
const RELATORIOS_ALVO = [
  "Vendas",
  "Ranking de vendedor",
  "Pedidos Faturados",
  "Produtos mais vendidos",
  "Produtos por pedido",
  "Positivação de produtos por cliente",
  "Estoque",
  "Situação de carteira",
  "Positivação de clientes",
  "Curva ABC",
  "Atendimentos",
  "Visitas",
  "Comissões",
  "Títulos",
  "Listagem de Clientes",
];

async function tabelaParaJson(page: Page): Promise<Record<string, string>[]> {
  return page.evaluate(() => {
    const tabela = document.querySelector("table");
    if (!tabela) return [];
    const ths = [...tabela.querySelectorAll("thead th")].map((t) => t.textContent?.trim() ?? "");
    const cab = ths.length > 0 ? ths : [...tabela.querySelectorAll("tr:first-child th, tr:first-child td")].map((t) => t.textContent?.trim() ?? "");
    return [...tabela.querySelectorAll("tbody tr")].map((tr) => {
      const obj: Record<string, string> = {};
      [...tr.querySelectorAll("td")].forEach((td, i) => {
        obj[cab[i] ?? `col_${i}`] = td.innerText.trim();
      });
      return obj;
    });
  });
}

async function tentarBaixarExcel(page: Page, nome: string): Promise<string | null> {
  const botao = page
    .getByRole("button", { name: /excel|xls|exportar|download/i })
    .or(page.locator('a[href*=".xls"], a[href*="export"], button[class*="export"]'))
    .first();
  if ((await botao.count()) === 0) return null;
  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      botao.click(),
    ]);
    const destino = join(SAIDA, `${nome}.xlsx`);
    await download.saveAs(destino);
    return destino;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();

  // Ponto de partida: home logada. O mapa do menu lateral diz onde cada coisa mora.
  await page.goto("https://app.mercos.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const menu = await page.evaluate(() =>
    [...document.querySelectorAll("nav a, aside a, [role='navigation'] a")].map((a) => ({
      texto: a.textContent?.trim().slice(0, 80) ?? "",
      href: (a as HTMLAnchorElement).href ?? "",
    })),
  );
  writeFileSync(join(SAIDA, "menu-lateral.json"), JSON.stringify(menu, null, 2), "utf8");

  // Indicadores > Relatórios: lista tudo que existe (para o "veja tudo que tem lá").
  await page.getByText(/indicadores/i).first().click().catch(() => {});
  await page.waitForTimeout(3000);
  const indicadores = await page.evaluate(() => ({
    url: location.href,
    titulo: document.title,
    links: [...document.querySelectorAll("a")].map((a) => a.textContent?.trim().slice(0, 100) ?? "").filter(Boolean).slice(0, 200),
    temExcel: document.body.innerHTML.toLowerCase().includes("excel"),
  }));
  writeFileSync(join(SAIDA, "indicadores-mapa.json"), JSON.stringify({ menu, indicadores, alvos: RELATORIOS_ALVO }, null, 2), "utf8");

  const resumo: Record<string, { excel: string | null; linhas: number }> = {};

  // Fase 2: telas de listagem diretas (URLs medidas no menu-lateral).
  const SECOES: Record<string, string> = {
    pedidos: "https://app.mercos.com/338282/pedidos/",
    clientes: "https://app.mercos.com/338282/clientes/",
    produtos: "https://app.mercos.com/industria/338282/produtos/",
  };
  for (const [nome, url] of Object.entries(SECOES)) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(5000); // SPA hidrata a grade
      const excel = await tentarBaixarExcel(page, nome);
      const linhas = await tabelaParaJson(page);
      if (linhas.length > 0) {
        writeFileSync(join(SAIDA, `${nome}.json`), JSON.stringify(linhas, null, 2), "utf8");
      }
      resumo[nome] = { excel, linhas: linhas.length };
    } catch {
      resumo[nome] = { excel: null, linhas: -1 };
    }
  }

  // Fotos dos produtos: coleta na tela de produtos (filtra assets estáticos do Mercos).
  const fotos = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll("img")].map((i) => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src))]
      .filter((s) => s.startsWith("http") && !/logo|megafone|rodape|sem_imagem|carregando|sprite|icon/i.test(s))
      .slice(0, 500),
  );
  writeFileSync(join(SAIDA, "fotos-produtos.json"), JSON.stringify(fotos, null, 2), "utf8");

  // Fase 3: aba RELATÓRIOS dentro de Indicadores — enumera e extrai cada relatório.
  try {
    await page.goto("https://app.mercos.com/338282/indicadores/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    await page.getByText(/relatórios/i).first().click({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const relatorios = await page.evaluate(() =>
      [...new Set([...document.querySelectorAll("main a, section a, table a")].map((a) => a.textContent?.trim().slice(0, 120) ?? "").filter(Boolean))],
    );
    writeFileSync(join(SAIDA, "relatorios-lista.json"), JSON.stringify(relatorios, null, 2), "utf8");
    for (const nome of relatorios.slice(0, 30)) {
      const slug = nome.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);
      if (!slug) continue;
      try {
        const link = page.getByRole("link", { name: new RegExp(nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40), "i") }).first();
        if ((await link.count()) === 0) continue;
        await link.click();
        await page.waitForTimeout(5000);
        const excel = await tentarBaixarExcel(page, `rel-${slug}`);
        const linhas = await tabelaParaJson(page);
        if (linhas.length > 0) {
          writeFileSync(join(SAIDA, `rel-${slug}.json`), JSON.stringify(linhas.slice(0, 2000), null, 2), "utf8");
        }
        resumo[`rel:${nome.slice(0, 50)}`] = { excel, linhas: linhas.length };
        await page.goBack().catch(() => {});
        await page.waitForTimeout(3000);
      } catch {
        /* segue para o próximo relatório */
      }
    }
  } catch {
    /* indicadores sem aba de relatórios visível */
  }
  writeFileSync(join(SAIDA, "resumo-extracao.json"), JSON.stringify({ resumo, totalFotos: fotos.length }, null, 2), "utf8");

  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`OK -> ${SAIDA} (menu-lateral.json, indicadores-mapa.json, resumo-extracao.json)`);
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
