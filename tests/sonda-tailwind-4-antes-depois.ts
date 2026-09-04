/**
 * ANTES/DEPOIS da migração Tailwind 3 → 4 — o item 3 do aceite da issue #239.
 *
 * Sobe as DUAS versões contra o MESMO banco fresco e compara, tela a tela:
 *
 *  a) **Diferença semântica** — para cada elemento, casado pelo caminho
 *     estrutural no DOM (e não pelo `className`, que a migração renomeou), lê o
 *     estilo COMPUTADO dos dois lados e reporta o que mudou. É a medida que
 *     responde "o que exatamente ficou diferente", que screenshot nenhum
 *     responde.
 *  b) **Tamanho da página** — a altura do PNG, que denuncia mudança de
 *     espaçamento acumulada mesmo quando nenhum elemento isolado chama atenção.
 *  c) Os PNGs pareados, para o humano olhar.
 *
 * Por que casar por caminho estrutural: a migração trocou `rounded` →
 * `rounded-md`, `outline-none` → `outline-hidden` e `flex-shrink-0` →
 * `shrink-0`. Casar por classe daria zero pares nesses elementos — justamente
 * os que mais interessam.
 *
 * Uso: com as duas versões de pé (v3 em :3002, v4 em :3001) contra o mesmo
 * Supabase local,
 *   set -a; . ./.env.e2e; set +a && pnpm exec tsx tests/sonda-tailwind-4-antes-depois.ts
 */
import { chromium, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ANTES = process.env.SONDA_ANTES ?? "http://localhost:3002"; // Tailwind 3
const DEPOIS = process.env.SONDA_DEPOIS ?? "http://localhost:3001"; // Tailwind 4
const EMAIL = process.env.SONDA_EMAIL ?? "qa-tw4@deskcomm.local";
const SENHA = process.env.SONDA_SENHA ?? "SenhaForte#2026tw4";
const RAIZ = "evidence/tailwind-4";

const TELAS: Array<[string, string]> = [
  ["01-login", "/login"],
  ["02-onboarding-welcome", "/onboarding/welcome"],
  ["03-onboarding-funil", "/onboarding/funil"],
  ["04-onboarding-equipe", "/onboarding/invite-team"],
  ["05-onboarding-ia", "/onboarding/setup-ai"],
  ["06-onboarding-whatsapp", "/onboarding/connect-whatsapp"],
  ["09-legal-privacidade", "/legal/privacy"],
];

/** Propriedades que a migração podia mexer. Ordem estável, para o diff casar. */
const PROPS = [
  "backgroundColor", "color", "borderTopColor", "borderTopWidth",
  "borderTopLeftRadius", "paddingTop", "paddingLeft", "marginTop",
  "marginBottom", "boxShadow", "outlineStyle", "outlineWidth", "flexShrink",
];

type Retrato = Record<string, Record<string, string>>;

async function retratoDaTela(page: Page): Promise<Retrato> {
  return page.evaluate((props) => {
    const saida: Record<string, Record<string, string>> = {};
    // Caminho estrutural: body > tag:índice > tag:índice … Estável entre as
    // duas versões porque o React renderiza a MESMA árvore; o que mudou foram
    // nomes de classe, que de propósito não entram na chave.
    const pilha: Array<[Element, string]> = [[document.body, "body"]];
    while (pilha.length) {
      const item = pilha.pop();
      if (!item) break;
      const el = item[0];
      const caminho = item[1];
      const cs = getComputedStyle(el);
      const reg: Record<string, string> = {};
      for (const p of props) reg[p] = cs[p as keyof CSSStyleDeclaration] as string;
      saida[caminho] = reg;
      const filhos = el.children;
      for (let i = filhos.length - 1; i >= 0; i--) {
        const f = filhos[i];
        if (!f) continue;
        pilha.push([f, `${caminho}>${f.tagName.toLowerCase()}:${i}`]);
      }
    }
    return saida;
  }, PROPS);
}

async function abrir(page: Page, base: string, rota: string) {
  await page.goto(`${base}${rota}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
}

async function entrar(page: Page, base: string) {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', SENHA);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
}

/**
 * Compara dois PNGs sem decodificar imagem: dimensões saem do cabeçalho IHDR
 * (bytes 16..24, fixos por especificação) e a igualdade sai de um hash do
 * arquivo.
 *
 * Não há diff por pixel de propósito. Ele exigiria `pngjs`/`sharp`, que aqui só
 * existem como dependência TRANSITIVA — um script de prova que depende de algo
 * que ninguém declarou quebra no primeiro `pnpm update` e ninguém entende por
 * quê. E o número que ele daria é o menos útil dos dois: quando a altura muda,
 * o diff por pixel simplesmente não roda; quem responde "o que exatamente
 * mudou" é o diff de estilo computado, logo abaixo.
 */
function compararPng(a: string, b: string): { antes: string; depois: string; iguais: boolean } {
  const ba = fs.readFileSync(a);
  const bb = fs.readFileSync(b);
  const dim = (buf: Buffer) => `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
  const hash = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");
  return { antes: dim(ba), depois: dim(bb), iguais: hash(ba) === hash(bb) };
}

(async () => {
  for (const d of ["antes", "depois"]) fs.mkdirSync(path.join(RAIZ, d), { recursive: true });

  const browser = await chromium.launch();
  const relatorio: Record<string, unknown> = {};

  for (const tema of ["claro", "escuro"] as const) {
    const retratos: Record<string, Record<string, Retrato>> = { antes: {}, depois: {} };

    for (const lado of ["antes", "depois"] as const) {
      const base = lado === "antes" ? ANTES : DEPOIS;
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await entrar(page, base);
      for (const par of TELAS) {
        const nome = par[0];
        const rota = par[1];
        await abrir(page, base, rota);
        if (tema === "escuro") {
          await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
          await page.waitForTimeout(300);
        }
        retratos[lado]![nome] = await retratoDaTela(page);
        await page.screenshot({
          path: path.join(RAIZ, lado, `${nome}-${tema}.png`),
          fullPage: true,
        });
      }
      await page.close();
    }

    // ── diferença semântica ────────────────────────────────────────────────
    for (const par of TELAS) {
      const nome = par[0];
      const a = retratos["antes"]![nome]!;
      const d = retratos["depois"]![nome]!;
      const mudancas: Record<string, Record<string, string>> = {};
      let elementosComparados = 0;
      for (const caminho of Object.keys(a)) {
        const ea = a[caminho];
        const ed = d[caminho];
        if (!ea || !ed) continue;
        elementosComparados++;
        for (const p of PROPS) {
          if (ea[p] !== ed[p]) {
            mudancas[p] ??= {};
            const chave = `${ea[p]} → ${ed[p]}`;
            mudancas[p]![chave] = String((Number(mudancas[p]![chave] ?? 0) || 0) + 1);
          }
        }
      }
      const png = compararPng(
        path.join(RAIZ, "antes", `${nome}-${tema}.png`),
        path.join(RAIZ, "depois", `${nome}-${tema}.png`),
      );
      relatorio[`${nome}/${tema}`] = {
        elementosComparados,
        soNoAntes: Object.keys(a).length - elementosComparados,
        tamanho: `${png.antes} → ${png.depois}`,
        pixelIdentico: png.iguais,
        mudancas,
      };
    }
  }

  fs.writeFileSync(path.join(RAIZ, "antes-depois.json"), JSON.stringify(relatorio, null, 2));
  await browser.close();
  console.log("ok");
})();
