/**
 * Sonda a API interna do Mercos (fase 4).
 *
 * Abre UMA página de detalhe com a sessão salva e registra todas as
 * requisições XHR/fetch + respostas JSON. Se o detalhe vier de um endpoint
 * JSON, o extrator rápido pode chamar esse endpoint direto (10-50x mais
 * rápido que raspar HTML, e com paralelismo).
 *
 * Uso: pnpm exec tsx scripts/mercos-scrape/sondar-api.ts [idPedido]
 * Saída: %TEMP%/opencode/mercos/sonda-api.json
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");

async function main(): Promise<void> {
  const id = process.argv[2] ?? "165512937";
  mkdirSync(SAIDA, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();

  const chamadas: { metodo: string; url: string; status?: number; jsonKeys?: string[] }[] = [];
  page.on("response", (resp) => {
    const url = resp.url();
    if (resp.request().resourceType() !== "xhr" && !url.includes("/api/")) return;
    const ct = resp.headers()["content-type"] ?? "";
    const item = { metodo: resp.request().method(), url: url.slice(0, 300), status: resp.status() };
    if (ct.includes("json")) {
      resp
        .json()
        .then((j) => {
          const keys = j && typeof j === "object" ? Object.keys(j).slice(0, 20) : [];
          chamadas.push({ ...item, jsonKeys: keys });
        })
        .catch(() => chamadas.push(item));
    } else {
      chamadas.push(item);
    }
  });

  await page.goto(`https://app.mercos.com/338282/pedidos/${id}/detalhar/`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  await page.waitForTimeout(5000);
  // Dispara possível lazy-load rolando a página.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);

  writeFileSync(join(SAIDA, "sonda-api.json"), JSON.stringify(chamadas, null, 2), "utf8");
  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`OK: ${chamadas.length} chamadas XHR/API registradas.`);
}

main().catch((e) => {
   
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
