/**
 * Varredura COMPLETA dos pedidos do Mercos (todas as páginas).
 *
 * Reusa a sessão de `.auth/mercos.json` — NÃO reloga, NÃO gasta tentativa.
 *
 * Fase A (rápida): pagina a lista `?ultimo_id=` coletando os ids de detalhe
 *   (`/pedidos/<id>/detalhar/`) até esgotar. Salva `pedido-ids.json`.
 * Fase B (lenta): visita cada detalhe ainda não salvo e extrai cabeçalho +
 *   itens. Tem RESUME: pula `pedido-<id>.json` que já existe.
 *
 * Uso:
 *   pnpm exec tsx scripts/mercos-scrape/detalhar-pedidos.ts ids
 *   pnpm exec tsx scripts/mercos-scrape/detalhar-pedidos.ts detalhar [limite]
 *   pnpm exec tsx scripts/mercos-scrape/detalhar-pedidos.ts 3   (amostra antiga)
 */
import { chromium, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSAO = join(process.cwd(), ".auth", "mercos.json");
const SAIDA = join(process.env.TEMP ?? process.env.TMP ?? "/tmp", "opencode", "mercos");
const LISTA = "https://app.mercos.com/338282/pedidos/";
const IDS_JSON = join(SAIDA, "pedido-ids.json");

const pausa = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function expandida(page: Page): Promise<boolean> {
  // Se a sessão morreu, o Mercos volta para o login.
  return page.evaluate(() => /entrar|login/i.test(document.title) && !!document.querySelector('input[type="password"]'));
}

async function tabelasDaPagina(page: Page): Promise<{ cab: string[]; linhas: Record<string, string>[] }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("table")].map((tabela) => {
      const ths = [...tabela.querySelectorAll("thead th")].map((t) => t.textContent?.trim() ?? "");
      const cab = ths.length > 0 ? ths : [...tabela.querySelectorAll("tr:first-child th")].map((t) => t.textContent?.trim() ?? "");
      const corpo = [...tabela.querySelectorAll("tbody tr")];
      const trs = corpo.length > 0 ? corpo : [...tabela.querySelectorAll("tr")].slice(cab.length > 0 ? 1 : 0);
      return {
        cab,
        linhas: trs.map((tr) => {
          const obj: Record<string, string> = {};
          [...tr.querySelectorAll("td")].forEach((td, i) => {
            obj[cab[i] ?? `col_${i}`] = td.innerText.trim().slice(0, 300);
          });
          return obj;
        }),
      };
    }),
  );
}

/** Fase A: coleta TODOS os ids de detalhe paginando via ultimo_id. */
async function faseIds(page: Page): Promise<string[]> {
  const PROGRESSO = join(SAIDA, "pedido-ids-progresso.json");
  const vistos = new Set<string>(
    existsSync(IDS_JSON) ? (JSON.parse(readFileSync(IDS_JSON, "utf8")) as string[]) : [],
  );
  let url: string | null = LISTA;
  let paginas = 0;
  if (existsSync(PROGRESSO)) {
    try {
      const prog = JSON.parse(readFileSync(PROGRESSO, "utf8")) as { url: string; total: number };
      if (prog.url && vistos.size > 0) {
        url = prog.url;
        // eslint-disable-next-line no-console
        console.log(`resume: ${vistos.size} ids já salvos, continua de ${prog.url.slice(-60)}`);
      }
    } catch {
      /* recomeça */
    }
  }
  while (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (await expandida(page)) throw new Error("Sessão expirada — refaça a captura manual e rode de novo.");
    await page.waitForTimeout(4000);
    const { ids, proxima } = await page.evaluate((base: string) => {
      const todos = [...document.querySelectorAll("a")].map((a) => (a as HTMLAnchorElement).href);
      const det = [...new Set(todos.filter((h) => /\/pedidos\/\d+\/detalhar\//.test(h)))];
      // Próxima página: link com ultimo_id diferente do atual.
      const atual = new URL(base).searchParams.get("ultimo_id");
      const prox = [...new Set(todos)].find((h) => {
        if (!/\/pedidos\/\?ultimo_id=/.test(h)) return false;
        return new URL(h).searchParams.get("ultimo_id") !== atual;
      });
      return { ids: det, proxima: prox ?? null };
    }, url);
    let novos = 0;
    for (const d of ids as string[]) {
      const m = d.match(/\/pedidos\/(\d+)\/detalhar\//);
      if (m && !vistos.has(m[1])) {
        vistos.add(m[1]);
        novos++;
      }
    }
    paginas++;
    // eslint-disable-next-line no-console
    console.log(`página ${paginas}: +${novos} pedidos (total ${vistos.size})`);
    if (paginas === 1) {
      // Contador oficial da lista ("Exibindo 1-20 de X", "N pedidos", etc).
      const totalizador = await page.evaluate(() =>
        [...document.body.innerText.split("\n")]
          .map((l) => l.trim())
          .filter((l) => /\d/.test(l) && /pedido|exibindo|total|de \d|resultados?/i.test(l))
          .slice(0, 10),
      );
      writeFileSync(join(SAIDA, "pedido-ids-total.json"), JSON.stringify(totalizador, null, 2), "utf8");
    }
    // Salvamento incremental: se o run morrer no timeout, nada se perde.
    if (paginas % 5 === 0 || novos === 0) {
      writeFileSync(IDS_JSON, JSON.stringify([...vistos], null, 2), "utf8");
    }
    writeFileSync(PROGRESSO, JSON.stringify({ url, total: vistos.size }), "utf8");
    url = novos > 0 ? (proxima as string | null) : null;
    await pausa(1500);
    if (paginas > 2000) break; // trava de segurança
  }
  const lista = [...vistos];
  writeFileSync(IDS_JSON, JSON.stringify(lista, null, 2), "utf8");
  try {
    const { rmSync } = await import("node:fs");
    rmSync(PROGRESSO, { force: true });
  } catch {
    /* sem progresso pendente */
  }
  return lista;
}

/** Fase B: detalha cada id ainda não salvo — pool de páginas em paralelo. */
async function faseDetalhar(page: Page, limite: number): Promise<void> {
  if (!existsSync(IDS_JSON)) throw new Error("Rode primeiro a fase 'ids'.");
  const ids = JSON.parse(readFileSync(IDS_JSON, "utf8")) as string[];
  const resumoPath = join(SAIDA, "detalhe-resumo.json");
  const resumo = (existsSync(resumoPath) ? JSON.parse(readFileSync(resumoPath, "utf8")) : {}) as Record<string, { itens: number; ok: boolean }>;
  const fila = ids.filter((id) => !existsSync(join(SAIDA, `pedido-${id}.json`))).slice(0, limite);
  const PARALELO = Number(process.env.MERCOS_PARALELO ?? "6");
  // eslint-disable-next-line no-console
  console.log(`detalhar: ${fila.length} na fila, ${PARALELO} páginas em paralelo, resume com ${Object.keys(resumo).length} prontos.`);

  const ctx = page.context();
  let feitos = 0;
  const salvar = (): void => writeFileSync(resumoPath, JSON.stringify(resumo, null, 2), "utf8");

  async function operario(): Promise<void> {
    const pg = await ctx.newPage();
    for (;;) {
      const id = fila.shift();
      if (!id) break;
      try {
        await pg.goto(`https://app.mercos.com/338282/pedidos/${id}/detalhar/`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        if (await expandida(pg)) throw new Error("Sessão expirada — refaça a captura manual e rode de novo.");
        await pg.waitForTimeout(2500);
        const bruto = await tabelasDaPagina(pg);
        // Remove linhas vazias e achata observações no item anterior.
        const tabelas = bruto.map((t) => ({
          cab: t.cab,
          linhas: t.linhas.filter((l) => Object.values(l).some((v) => v !== "")),
        }));
        const cabecalho = await pg.evaluate(() => document.body.innerText.slice(0, 4000));
        writeFileSync(join(SAIDA, `pedido-${id}.json`), JSON.stringify({ id, cabecalho, tabelas }, null, 2), "utf8");
        const itens = tabelas.reduce((acc, t) => acc + t.linhas.length, 0);
        resumo[id] = { itens, ok: itens > 0 };
      } catch {
        resumo[id] = { itens: 0, ok: false };
      }
      feitos++;
      if (feitos % 25 === 0) {
        salvar();
        // eslint-disable-next-line no-console
        console.log(`detalhados ${feitos}/${fila.length + feitos} (${Object.keys(resumo).length}/${ids.length} no total)`);
      }
      await pausa(400);
    }
    await pg.close();
  }

  await Promise.all(Array.from({ length: Math.min(PARALELO, fila.length) }, () => operario()));
  salvar();
  // eslint-disable-next-line no-console
  console.log(`OK: ${Object.keys(resumo).length}/${ids.length} pedidos no resumo.`);
}

async function main(): Promise<void> {
  mkdirSync(SAIDA, { recursive: true });
  const modo = process.argv[2] ?? "ids";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "pt-BR", storageState: SESSAO });
  const page = await context.newPage();
  try {
    if (modo === "ids") await faseIds(page);
    else if (modo === "detalhar") await faseDetalhar(page, Number(process.argv[3] ?? "100000"));
    else {
      // Compat: número = amostra antiga pelos links da lista (só /detalhar/).
      await page.goto(LISTA, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(5000);
      const links = await page.evaluate(() =>
        [...new Set(
          [...document.querySelectorAll("a")]
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((h) => /\/pedidos\/\d+\/detalhar\//.test(h)),
        )].slice(0, 50),
      );
      writeFileSync(join(SAIDA, "pedido-links.json"), JSON.stringify(links, null, 2), "utf8");
      writeFileSync(IDS_JSON, JSON.stringify(links.map((l) => l.match(/\/pedidos\/(\d+)\//)?.[1] ?? "").filter(Boolean), null, 2), "utf8");
      // eslint-disable-next-line no-console
      console.log(`amostra: ${links.length} links. Rode 'ids' para varredura total.`);
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
