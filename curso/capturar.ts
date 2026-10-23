/**
 * Captura as fotos do curso ilustrado: executa cada passo das lições no app
 * REAL e grava a foto + a posição medida de cada destaque.
 *
 * Pré-requisito: app de pé (`next start`) sobre um banco com o seed de
 * demonstração (curso/semear-demonstracao.ts), que grava curso/saida/contas.json.
 *
 *   CURSO_URL=http://127.0.0.1:3460 pnpm exec tsx curso/capturar.ts [modulo]
 *
 * CURSO_ANTES_DA_LICAO (opcional): comando rodado antes de cada lição — em
 * geral o seed de demonstração, para toda lição partir do mesmo estado.
 *
 * Saída: curso/saida/capturas/<licao>--<passo>.jpg e curso/saida/capturas.json.
 * Sai com 1 se algum alvo não foi achado — a lista diz qual passo quebrou.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium, type Locator, type Page } from "@playwright/test";

import { type Acao, type Alvo, Modulo, chaveDoPasso } from "./licao";

const RAIZ = path.dirname(new URL(import.meta.url).pathname);
const SAIDA = path.join(RAIZ, "saida");
const FOTOS = path.join(SAIDA, "capturas");
const URL_BASE = process.env.CURSO_URL ?? "http://127.0.0.1:3460";
const LARGURA = 1440;
const ALTURA = 900;

type Caixa = { x: number; y: number; w: number; h: number };
export type Captura = {
  foto: string;
  destaques: Array<Caixa & { rotulo: string; tipo: string }>;
  clicar: Caixa | null;
};

const contas: Record<string, { email: string; senha: string }> = JSON.parse(
  readFileSync(path.join(SAIDA, "contas.json"), "utf8"),
);

type Raiz = Pick<Page, "getByTestId" | "getByRole" | "getByLabel" | "getByPlaceholder" | "getByText" | "locator">;

function localizar(raiz: Raiz, a: Omit<Alvo, "dentro"> & { dentro?: Alvo["dentro"] }): Locator {
  const base: Raiz = a.dentro ? localizar(raiz, a.dentro) : raiz;
  const exact = a.exato ?? false;
  const nome = a.nome === undefined ? undefined : a.regex ? new RegExp(a.nome) : a.nome;
  let l: Locator;
  if (a.testid) l = base.getByTestId(a.testid);
  else if (a.role) l = base.getByRole(a.role as Parameters<Page["getByRole"]>[0], nome === undefined ? {} : { name: nome, exact });
  else if (a.rotulo) l = base.getByLabel(a.rotulo, { exact });
  else if (a.placeholder) l = base.getByPlaceholder(a.placeholder, { exact });
  else if (a.texto) l = base.getByText(a.regex ? new RegExp(a.texto) : a.texto, { exact });
  else l = base.locator(a.css!);
  return a.n === undefined ? l : l.nth(a.n);
}

async function medir(page: Page, a: Alvo): Promise<Caixa> {
  const l = localizar(page, a);
  await l.waitFor({ state: "visible", timeout: 8_000 });
  const b = await l.boundingBox();
  if (!b) throw new Error("sem caixa (fora da tela?)");
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { x, y, w: Math.min(b.width, LARGURA - x), h: Math.min(b.height, ALTURA - y) };
}

async function executar(page: Page, a: Acao) {
  if (a.acao === "press") return page.keyboard.press(a.tecla);
  if (a.acao === "esperar") return page.waitForTimeout(a.ms);
  if (a.acao === "aguardar") return localizar(page, a.alvo).waitFor({ state: "visible", timeout: 15_000 });
  const l = localizar(page, a.alvo);
  if (a.acao === "click") await l.click({ timeout: 8_000 });
  else if (a.acao === "hover") await l.hover({ timeout: 8_000 });
  else await l.fill(a.valor, { timeout: 8_000 });
  await page.waitForTimeout(600); // animação de abertura de menu/diálogo
}

/** Congela o que muda entre rodadas e atrapalharia a foto. */
const CSS_DE_FOTO = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}
[data-sonner-toaster],nextjs-portal{display:none!important}`;

async function entrar(page: Page, papel: string) {
  const c = contas[papel];
  if (!c) throw new Error(`curso/saida/contas.json não tem a conta "${papel}"`);
  await page.goto(`${URL_BASE}/login`);
  await page.waitForLoadState("networkidle");
  // pressSequentially: o fill() não dispara os listeners do React Hook Form do login
  for (const [sel, valor] of [['input[type="email"]', c.email], ['input[type="password"]', c.senha]] as const) {
    const campo = page.locator(sel);
    await campo.focus();
    await campo.pressSequentially(valor, { delay: 15 });
  }
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

async function main() {
  const filtro = process.argv[2];
  const arquivos = readdirSync(path.join(RAIZ, "licoes")).filter((f) => f.endsWith(".json"));
  const modulos = arquivos
    .map((f) => Modulo.parse(JSON.parse(readFileSync(path.join(RAIZ, "licoes", f), "utf8"))))
    .filter((m) => !filtro || m.id === filtro);
  mkdirSync(FOTOS, { recursive: true });

  const browser = await chromium.launch();
  const arquivoCapturas = path.join(SAIDA, "capturas.json");
  const capturas: Record<string, Captura> = existsSync(arquivoCapturas) ? JSON.parse(readFileSync(arquivoCapturas, "utf8")).capturas : {};
  const falhas: string[] = [];
  const sessoes = new Map<string, string>(); // papel -> storageState em disco

  for (const modulo of modulos) {
    for (const licao of modulo.licoes) {
      // cada lição parte do mesmo estado: assumir, fechar e transferir mudam o banco
      if (process.env.CURSO_ANTES_DA_LICAO) execSync(process.env.CURSO_ANTES_DA_LICAO, { stdio: "inherit" });
      if (!sessoes.has(licao.papel)) {
        const ctx = await browser.newContext({ viewport: { width: LARGURA, height: ALTURA } });
        const p = await ctx.newPage();
        await entrar(p, licao.papel);
        const arquivo = path.join(SAIDA, `.sessao-${licao.papel}.json`);
        await ctx.storageState({ path: arquivo });
        sessoes.set(licao.papel, arquivo);
        await ctx.close();
      }
      // contexto novo por lição: estado de UI de uma lição não vaza para a seguinte
      const ctx = await browser.newContext({
        viewport: { width: LARGURA, height: ALTURA },
        deviceScaleFactor: 2,
        storageState: sessoes.get(licao.papel),
        locale: "pt-BR",
        timezoneId: "America/Sao_Paulo",
      });
      const page = await ctx.newPage();
      for (const passo of licao.passos) {
        const chave = chaveDoPasso(licao.id, passo.id);
        try {
          if (passo.rota) {
            await page.goto(URL_BASE + passo.rota);
            await page.waitForLoadState("networkidle");
          }
          await page.addStyleTag({ content: CSS_DE_FOTO });
          for (const a of passo.antes) await executar(page, a);
          const primeiro = passo.destaques[0]?.alvo ?? passo.clicar;
          if (primeiro) await localizar(page, primeiro).scrollIntoViewIfNeeded({ timeout: 8_000 });
          await page.mouse.move(0, ALTURA - 1); // tira o hover que sobrou da última ação
          await page.waitForTimeout(400);
          const destaques = [];
          for (const d of passo.destaques) {
            destaques.push({ ...(await medir(page, d.alvo)), rotulo: d.rotulo, tipo: d.tipo });
          }
          const clicar = passo.clicar ? await medir(page, passo.clicar) : null;
          const foto = `capturas/${chave}.jpg`;
          await page.screenshot({ path: path.join(SAIDA, foto), type: "jpeg", quality: 82 });
          capturas[chave] = { foto, destaques, clicar };
          console.info(`ok   ${modulo.id}/${chave}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
          falhas.push(`${modulo.id}/${chave}: ${msg}`);
          console.info(`FALHA ${modulo.id}/${chave}: ${msg}`);
          await page.screenshot({ path: path.join(SAIDA, `falha-${chave}.jpg`), type: "jpeg", quality: 60 }).catch(() => {});
        }
      }
      await ctx.close();
    }
  }
  await browser.close();
  writeFileSync(
    arquivoCapturas,
    JSON.stringify({ largura: LARGURA, altura: ALTURA, capturas, falhas }, null, 2),
  );
  console.info(`\n${Object.keys(capturas).length} fotos, ${falhas.length} falhas`);
  if (falhas.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
