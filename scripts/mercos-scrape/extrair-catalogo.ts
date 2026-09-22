/**
 * Catálogo completo de Produtos + base de Clientes do Mercos (fase 5).
 *
 * Reusa a sessão de `.auth/mercos.json` — NÃO reloga.
 * - Produtos: grade (foto miniatura, código, nome, IPI, unidade, comissão,
 *   preço) paginando em 1,2,3… Próxima até repetir.
 * - Clientes: cards (nome, CNPJ, telefone, cidade + link Alterar p/ detalhe
 *   futuro) paginando igual. Carteira (ativos/inativos/prospects) vai junto.
 * Resume por arquivo de página: `produtos-pag-N.json`, `clientes-pag-N.json`.
 *
 * Uso:
 *   pnpm exec tsx scripts/mercos-scrape/extrair-catalogo.ts [produtos|clientes|tudo]
 */
import { chromium, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

const JS_PRODUTOS = `(() => {
  var linhas = Array.from(document.querySelectorAll("table tbody tr")).map(function (tr) {
    var tds = tr.querySelectorAll("td");
    function txt(i) { return (tds[i] && tds[i].innerText || "").trim().slice(0, 200); }
    var img = tr.querySelector("td img");
    var src = img ? (img.currentSrc || img.src) : "";
    return { codigo: txt(2), nome: txt(3), ipi: txt(4), unidade: txt(5), comissao: txt(6), preco_tabela: txt(7), foto: src };
  });
  var fotos = Array.from(new Set(
    Array.from(document.querySelectorAll("table tbody tr td img"))
      .map(function (i) { return i.currentSrc || i.src; })
      .filter(function (s) { return s.indexOf("http") === 0 && !/logo|megafone|sem_imagem|carregando/i.test(s); })
  )).slice(0, 100);
  return { linhas: linhas, fotos: fotos };
})()`;

const JS_CLIENTES = `(() => {
  var reDoc = /(\\d{2}\\.\\d{3}\\.\\d{3}\\/\\d{4}-\\d{2}|\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2})/;
  var vistos = {};
  var out = [];
  var els = document.querySelectorAll("h1,h2,h3,h4,strong,b,span,div,p");
  for (var k = 0; k < els.length && out.length < 60; k++) {
    var txt = (els[k].textContent || "").trim().replace(/\\s+/g, " ");
    var m = txt.match(reDoc);
    if (!m || txt.length > 140 || vistos[m[0]]) continue;
    vistos[m[0]] = 1;
    var card = els[k];
    for (var i = 0; i < 6 && card; i++) {
      if (/\\(\\d{2}\\)/.test(card.innerText) && card.querySelector("a")) break;
      card = card.parentElement;
    }
    var corpo = card ? card.innerText : txt;
    var fone = (corpo.match(/\\(\\d{2}\\) \\d{4,5}-?\\d{4}/) || [])[0] || null;
    var cidade = null;
    var partes = corpo.split("\\n");
    for (var j = 0; j < partes.length; j++) {
      var l = partes[j].trim();
      if (/^[A-Z][A-Z ]{3,40}$/.test(l) && !/\\d/.test(l)) { cidade = l; break; }
    }
    var alterar = null;
    var as = card ? card.querySelectorAll("a") : [];
    for (var a = 0; a < as.length; a++) {
      if (/alterar|editar|clientes\\/\\d+/i.test(as[a].href)) { alterar = as[a].href; break; }
    }
    out.push({ nome: txt.replace(m[0], "").replace(/^[-\\s]+|[-\\s]+$/g, "").slice(0, 100), documento: m[0], fone: fone, cidade: cidade, alterar: alterar });
  }
  var found = null;
  var all = document.querySelectorAll("*");
  for (var q = 0; q < all.length; q++) {
    if (/CARTEIRA DE CLIENTES/.test((all[q].textContent || "").slice(0, 60))) { found = all[q]; break; }
  }
  var carteira = found && found.parentElement ? found.parentElement.innerText.replace(/\\s+/g, " ").slice(0, 500) : "";
  return { cards: out, carteira: carteira };
})()`;

async function extrairPaginaProdutos(page: Page): Promise<{ linhas: Record<string, string>[]; fotos: string[] }> {
   
  return page.evaluate(JS_PRODUTOS) as unknown as { linhas: Record<string, string>[]; fotos: string[] };
}

async function extrairPaginaClientes(page: Page): Promise<{ cards: Record<string, string | null>[]; carteira: string }> {
   
  return page.evaluate(JS_CLIENTES) as unknown as { cards: Record<string, string | null>[]; carteira: string };
}

async function paginar(
  page: Page,
  primeiraUrl: string,
  prefixo: string,
  extrair: (p: Page) => Promise<unknown>,
): Promise<number> {
  let pag = 1;
  let anterior = "";
  for (;;) {
    const destino = join(SAIDA, `${prefixo}-pag-${pag}.json`);
    // Sempre navega (mesmo com resume): a comparação de repetição precisa da página atual.
    if (pag === 1) {
      await page.goto(primeiraUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } else {
      const num = page.getByRole("link", { name: new RegExp(`^${pag}$`) }).first();
      const prox = page.getByRole("link", { name: /próxima/i }).first();
      if ((await num.count()) > 0) await num.click();
      else if ((await prox.count()) > 0) await prox.click();
      else break;
    }
    await page.waitForTimeout(5000);
    // Fim quando a página atual repete a anterior (Próxima esgotada).
    const assinatura = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    if (assinatura === anterior) break;
    anterior = assinatura;
    if (!existsSync(destino)) {
      const dados = await extrair(page);
      writeFileSync(destino, JSON.stringify({ pag, url: page.url(), dados }, null, 2), "utf8");
      // eslint-disable-next-line no-console
      console.log(`${prefixo} pág ${pag} salva`);
    }
    pag++;
    if (pag > 1000) break;
  }
  return pag - 1;
}

async function main(): Promise<void> {
  const alvo = process.argv[2] ?? "tudo";
  mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();
  try {
    if (alvo === "produtos" || alvo === "tudo") {
      const n = await paginar(page, "https://app.mercos.com/industria/338282/produtos/", "produtos", extrairPaginaProdutos);
      // eslint-disable-next-line no-console
      console.log(`produtos: ${n} páginas.`);
    }
    if (alvo === "clientes" || alvo === "tudo") {
      const n = await paginar(page, "https://app.mercos.com/338282/clientes/", "clientes", extrairPaginaClientes);
      // eslint-disable-next-line no-console
      console.log(`clientes: ${n} páginas.`);
    }
  } finally {
    await browser.close();
  }
  // eslint-disable-next-line no-console
  console.log(`OK -> ${SAIDA}`);
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
