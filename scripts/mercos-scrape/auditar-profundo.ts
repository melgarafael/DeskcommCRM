/** Varredura profunda do Mercos: todas as seções, abas e botões (gap completo). */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos", "auditoria");
const BASE = "https://app.mercos.com/338282";

const URLS: [string, string][] = [
  ["cfg-pedidos", `${BASE}/pedidos/configuracoes-pedidos/campo_custom/`],
  ["pedido-novo", `${BASE}/pedidos/atalho/novo/`],
  ["clientes-config", `${BASE}/clientes/`],
  ["clientes-importar", `${BASE}/clientes/importar_excel/`],
  ["prod-promocoes", `https://app.mercos.com/industria/338282/produtos/`],
  ["rel-faturamento", `${BASE}/relatorios/faturamento/`],
  ["rel-titulos", `${BASE}/indicadores/titulos/`],
  ["rel-carteira", `${BASE}/indicadores/situacao-de-carteira/`],
  ["rel-carteira-vend", `${BASE}/indicadores/situacao-carteira-por-vendedor/`],
  ["rel-positivacao", `${BASE}/indicadores/positivacao-de-clientes/`],
  ["rel-curva-abc", `${BASE}/indicadores/curva-abc/`],
  ["rel-comissoes", `${BASE}/comissoes/`],
  ["rel-comissoes-ped", `${BASE}/relatorios/comissoes_pedido/`],
  ["rel-mais-vendidos", `${BASE}/indicadores/produtos-mais-vendidos/`],
  ["rel-positiv-prod", `${BASE}/indicadores/positivacao-de-produtos-por-cliente/`],
  ["rel-estoque", `${BASE}/relatorios/estoque/`],
  ["rel-ranking", `${BASE}/indicadores/ranking-de-vendedores/`],
  ["rel-atend", `${BASE}/indicadores/atendimentos/`],
  ["rel-portal-met", `${BASE}/relatorios/metricas_b2b/`],
  ["rel-emails", `${BASE}/relatorios/emails_enviados/`],
  ["rel-vendas-antigo", `${BASE}/relatorios/vendas_antigo/`],
  ["rel-representada", `${BASE}/relatorios/representada/`],
];

async function main(): Promise<void> {
  mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();
  const indice: Record<string, unknown> = {};

  for (const [slug, url] of URLS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(5000);
const JS_AUDIT = `(() => {
  function txt(e) { return ((e && e.textContent) || "").trim().replace(/\\s+/g, " ").slice(0, 80); }
  function uniq(arr) { var s = {}; var out = []; for (var i = 0; i < arr.length; i++) { if (arr[i] && !s[arr[i]]) { s[arr[i]] = 1; out.push(arr[i]); } } return out; }
  var abas = [];
  var q1 = document.querySelectorAll("[role='tab'], nav a");
  for (var i = 0; i < q1.length; i++) abas.push(txt(q1[i]));
  var botoes = [];
  var q2 = document.querySelectorAll("button");
  for (var j = 0; j < q2.length; j++) botoes.push(txt(q2[j]));
  var h1 = [];
  var q3 = document.querySelectorAll("h1");
  for (var k = 0; k < q3.length; k++) h1.push(txt(q3[k]));
  var kpis = [];
  var m = document.body.innerText.match(/R\\$ [\\d.,]+|\\d+[.,]\\d+\\s?%/g) || [];
  for (var w = 0; w < Math.min(m.length, 15); w++) kpis.push(m[w]);
  var tabelas = [];
  var q4 = document.querySelectorAll("table");
  for (var t = 0; t < Math.min(q4.length, 3); t++) {
    var ths = [];
    var q5 = q4[t].querySelectorAll("thead th");
    for (var c = 0; c < Math.min(q5.length, 12); c++) ths.push(txt(q5[c]));
    tabelas.push({ cab: ths, n: q4[t].querySelectorAll("tbody tr").length });
  }
  return {
    titulo: document.title,
    h1: h1.slice(0, 5),
    abas: uniq(abas).slice(0, 25),
    botoes: uniq(botoes).slice(0, 35),
    bloqueado: /não está disponível no seu plano/i.test(document.body.innerText),
    kpis: kpis,
    tabelas: tabelas
  };
})()`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dados = (await page.evaluate(JS_AUDIT)) as any;
      writeFileSync(join(SAIDA, `deep-${slug}.json`), JSON.stringify({ url: page.url(), ...dados }, null, 2), "utf8");
      indice[slug] = { abas: (dados.abas as string[]).length, botoes: (dados.botoes as string[]).length, bloqueado: dados.bloqueado };
    } catch (e) {
      indice[slug] = { erro: e instanceof Error ? e.message.slice(0, 120) : String(e) };
    }
  }

  writeFileSync(join(SAIDA, "deep-indice.json"), JSON.stringify(indice, null, 2), "utf8");
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
