/** Auditoria de produto do Mercos (fase 6): estrutura + telas por seção. */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos", "auditoria");

const SECOES: [string, string][] = [
  ["indicadores-paineis", "https://app.mercos.com/338282/indicadores/"],
  ["pedidos-lista", "https://app.mercos.com/338282/pedidos/"],
  ["clientes", "https://app.mercos.com/338282/clientes/"],
  ["produtos", "https://app.mercos.com/industria/338282/produtos/"],
  ["portal", "https://app.mercos.com/338282/configuracoes-portal-e-ecommerce/"],
  ["tarefas", "https://app.mercos.com/338282/agenda/"],
  ["mercos-ia", "https://app.mercos.com/338282/mercos-ia/"],
  ["minha-conta", "https://app.mercos.com/338282/meu-perfil/"],
];

async function main(): Promise<void> {
  mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const indice: Record<string, unknown> = {};

  for (const [slug, url] of SECOES) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(6000);
      const dados = await page.evaluate(() => ({
        titulo: document.title,
        h1h2: [...document.querySelectorAll("h1,h2")].map((e) => (e.textContent || "").trim().slice(0, 80)).filter(Boolean).slice(0, 15),
        abas: [...document.querySelectorAll("[role='tab'], nav a, .nav-link")]
          .map((e) => (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60))
          .filter(Boolean)
          .slice(0, 30),
        botoes: [...new Set(
          [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50)).filter(Boolean),
        )].slice(0, 40),
        kpis: [...document.body.innerText.matchAll(/R\$ [\d.,]+|\d+[.,]\d+\s?%|\d+\s?(pedidos|clientes|produtos|visitas|vendedores)/gi)]
          .map((m) => m[0])
          .slice(0, 30),
        tabelas: [...document.querySelectorAll("table")].map((t) => ({
          cab: [...t.querySelectorAll("thead th")].map((x) => (x.textContent || "").trim()).slice(0, 12),
          n: t.querySelectorAll("tbody tr").length,
        })).slice(0, 4),
      }));
      writeFileSync(join(SAIDA, `${slug}.json`), JSON.stringify({ url: page.url(), ...dados }, null, 2), "utf8");
      await page.screenshot({ path: join(SAIDA, `${slug}.png`) });
      indice[slug] = { url: page.url(), abas: (dados.abas as string[]).length, botoes: (dados.botoes as string[]).length };
    } catch (e) {
      indice[slug] = { erro: e instanceof Error ? e.message.slice(0, 150) : String(e) };
    }
  }

  writeFileSync(join(SAIDA, "indice.json"), JSON.stringify(indice, null, 2), "utf8");
  await browser.close();
  // eslint-disable-next-line no-console
  console.log("OK");
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
