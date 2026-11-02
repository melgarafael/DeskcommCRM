/**
 * Captura as fotos do curso ilustrado: executa cada passo das lições no app
 * REAL e grava a foto + a posição medida de cada destaque.
 *
 * Pré-requisito: app de pé (`next start`) sobre um banco com o seed de
 * demonstração (curso/semear-demonstracao.ts), que grava curso/saida/contas.json.
 *
 *   CURSO_URL=http://127.0.0.1:3460 pnpm exec tsx curso/capturar.ts [modulo] [licao]
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

import { caixaNaFoto } from "./geometria";
import {
  alvoNoIdioma,
  commitDaFoto,
  idiomaDaCaptura,
  pastaDaSaida,
  textoDaInterface,
} from "./idioma";
import { abrirManifestoDaRodada } from "./manifesto";
import { exigirHttpLocal } from "./seguranca";
import { type Acao, type Alvo, Modulo, chaveDoPasso } from "./licao";

const RAIZ = path.dirname(new URL(import.meta.url).pathname);
const SAIDA = pastaDaSaida();
const FOTOS = path.join(SAIDA, "capturas");
const URL_BASE = exigirHttpLocal(process.env.CURSO_URL ?? "http://127.0.0.1:3460");
const LARGURA = 1440;
const ALTURA = 900;

type Caixa = { x: number; y: number; w: number; h: number };
export type Captura = {
  foto: string;
  /** Versão do app fotografado, independente do checkout onde se monta o curso. */
  versao?: string;
  capturado_em?: string;
  idioma?: "pt-BR" | "es";
  commit_fonte?: string;
  destaques: Array<Caixa & { rotulo: string; tipo: string }>;
  clicar: Caixa | null;
};

type Raiz = Pick<
  Page,
  "getByTestId" | "getByRole" | "getByLabel" | "getByPlaceholder" | "getByText" | "locator"
>;

export function localizar(
  raiz: Raiz,
  a: Omit<Alvo, "dentro"> & { dentro?: Alvo["dentro"] },
): Locator {
  a = alvoNoIdioma(a);
  const base: Raiz = a.dentro ? localizar(raiz, a.dentro) : raiz;
  const exact = a.exato ?? false;
  const nome = a.nome === undefined ? undefined : a.regex ? new RegExp(a.nome) : a.nome;
  let l: Locator;
  if (a.testid) l = base.getByTestId(a.testid);
  else if (a.role)
    l = base.getByRole(
      a.role as Parameters<Page["getByRole"]>[0],
      nome === undefined ? {} : { name: nome, exact },
    );
  else if (a.rotulo) l = base.getByLabel(a.rotulo, { exact });
  else if (a.placeholder) l = base.getByPlaceholder(a.placeholder, { exact });
  else if (a.texto) l = base.getByText(a.regex ? new RegExp(a.texto) : a.texto, { exact });
  else l = base.locator(a.css!);
  return a.n === undefined ? l : l.nth(a.n);
}

export async function medir(page: Page, a: Alvo): Promise<Caixa> {
  const l = localizar(page, a);
  await l.waitFor({ state: "visible", timeout: 8_000 });
  const b = await l.boundingBox();
  if (!b) throw new Error("sem caixa (fora da tela?)");
  return caixaNaFoto(b, LARGURA, ALTURA);
}

export async function executar(page: Page, a: Acao) {
  if (a.acao === "press") {
    if (a.alvo) await localizar(page, a.alvo).press(a.tecla, { timeout: 8_000 });
    else await page.keyboard.press(a.tecla);
    return page.waitForTimeout(600);
  }
  if (a.acao === "esperar") return page.waitForTimeout(a.ms);
  if (a.acao === "aguardar")
    return localizar(page, a.alvo).waitFor({ state: "visible", timeout: 15_000 });
  if (a.acao === "rolar") return localizar(page, a.alvo).scrollIntoViewIfNeeded({ timeout: 8_000 });
  if (a.acao === "selecionar") {
    await localizar(page, a.alvo).selectOption(
      { label: textoDaInterface(a.opcao) },
      { timeout: 8_000 },
    );
    return page.waitForTimeout(600);
  }
  const l = localizar(page, a.alvo);
  if (a.acao === "click") await l.click({ timeout: 8_000 });
  else if (a.acao === "hover") await l.hover({ timeout: 8_000 });
  else await l.fill(textoDaInterface(a.valor), { timeout: 8_000 });
  await page.waitForTimeout(600); // animação de abertura de menu/diálogo
}

/** Esqueletos e regiões ocupadas na foto ensinam uma tela que ainda não chegou. */
export async function esperarCarregar(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    // Os divs cobrem o carregamento legado do Funil. Ícones e a bolinha de
    // saúde de Conexões também pulsam, mas não representam carregamento.
    () =>
      ![
        ...document.querySelectorAll("[data-esqueleto], [aria-busy='true'], div.animate-pulse"),
      ].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"),
    null,
    { timeout: 15_000 },
  );
}

/**
 * O clique deixa um anel de foco no botão, que na foto parece uma caixa sem
 * explicação. Tira o foco — menos de campo de texto e de menu/diálogo/lista
 * aberta, que fecham ou mudam de cara sem ele.
 */
export async function tirarFocoDeClique(page: Page) {
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return;
    if (el.matches("input, textarea, [contenteditable='true']")) return;
    if (el.closest("[role=menu], [role=dialog], [role=alertdialog], [role=listbox]")) return;
    el.blur();
  });
}

/** Congela o que muda entre rodadas e atrapalharia a foto. */
export const CSS_DE_FOTO = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}
[data-sonner-toaster],nextjs-portal{display:none!important}`;

export async function entrar(page: Page, papel: string, urlBase = URL_BASE) {
  const contas: Record<string, { email: string; senha: string }> = JSON.parse(
    readFileSync(path.join(RAIZ, "saida", "contas.json"), "utf8"),
  );
  const c = contas[papel];
  if (!c) throw new Error(`curso/saida/contas.json não tem a conta "${papel}"`);
  await page.goto(`${urlBase}/login`);
  await page.waitForLoadState("networkidle");
  // pressSequentially: o fill() não dispara os listeners do React Hook Form do login
  for (const [sel, valor] of [
    ['input[type="email"]', c.email],
    ['input[type="password"]', c.senha],
  ] as const) {
    const campo = page.locator(sel);
    await campo.focus();
    await campo.pressSequentially(valor, { delay: 15 });
  }
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}

/** Uma rodada de lições não conclui as recapturas pendentes das jornadas. */
export function salvarManifestoDasLicoes(
  arquivo: string,
  capturas: Record<string, Captura>,
  falhas: string[],
) {
  const anteriores: string[] = existsSync(arquivo)
    ? (JSON.parse(readFileSync(arquivo, "utf8")).falhas ?? [])
    : [];
  const jornadasPendentes = anteriores.filter((chave) =>
    /^demo-[a-z0-9-]+--historia--[a-z0-9-]+$/.test(chave),
  );
  writeFileSync(
    arquivo,
    JSON.stringify(
      { largura: LARGURA, altura: ALTURA, capturas, falhas: [...jornadasPendentes, ...falhas] },
      null,
      2,
    ),
  );
}

async function main() {
  const filtro = process.argv[2];
  const soLicao = process.argv[3]; // depuração: uma lição só
  // filtra ANTES de ler: a lição quebrada de um módulo não derruba a captura de outro
  const arquivos = readdirSync(path.join(RAIZ, "licoes")).filter(
    (f) => f.endsWith(".json") && (!filtro || f === `${filtro}.json`),
  );
  const modulos = arquivos.map((f) =>
    Modulo.parse(JSON.parse(readFileSync(path.join(RAIZ, "licoes", f), "utf8"))),
  );
  mkdirSync(FOTOS, { recursive: true });

  // locale do contexto muda a página, não os controles nativos: sem --lang, data e arquivo saem em inglês
  const idioma = idiomaDaCaptura();
  const arquivoCapturas = path.join(SAIDA, "capturas.json");
  const selecionadas = modulos.flatMap((m) =>
    m.licoes
      .filter((l) => !soLicao || l.id === soLicao)
      .flatMap((l) => l.passos.map((p) => chaveDoPasso(m.id, l.id, p.id))),
  );
  if (!selecionadas.length) throw new Error("filtro sem lições");
  abrirManifestoDaRodada(arquivoCapturas, selecionadas);
  const browser = await chromium.launch({
    channel: process.env.CURSO_BROWSER_CHANNEL || undefined,
    args: [`--lang=${idioma}`],
    env: {
      ...process.env,
      LANG: idioma === "es" ? "es_ES.UTF-8" : "pt_BR.UTF-8",
      LANGUAGE: idioma === "es" ? "es" : "pt_BR",
    },
  });
  const falhas: string[] = [];
  const sessoes = new Map<string, string>(); // papel -> storageState em disco

  for (const modulo of modulos) {
    for (const licao of modulo.licoes.filter((l) => !soLicao || l.id === soLicao)) {
      const registrar = abrirManifestoDaRodada(
        arquivoCapturas,
        licao.passos.map((p) => chaveDoPasso(modulo.id, licao.id, p.id)),
      );
      // cada lição parte do mesmo estado: assumir, fechar e transferir mudam o banco
      if (process.env.CURSO_ANTES_DA_LICAO)
        execSync(process.env.CURSO_ANTES_DA_LICAO, { stdio: "inherit" });
      if (!sessoes.has(licao.papel)) {
        const ctx = await browser.newContext({ viewport: { width: LARGURA, height: ALTURA } });
        const p = await ctx.newPage();
        await entrar(p, licao.papel);
        const seletor = p.getByTestId("seletor-de-idioma");
        await seletor.waitFor({ state: "visible", timeout: 15_000 });
        if ((await seletor.innerText()).trim() !== (idioma === "es" ? "ES" : "PT")) {
          throw new Error(
            "a conta não está no idioma pedido para as fotos; prepare novamente a bancada",
          );
        }
        const arquivo = path.join(SAIDA, `.sessao-${licao.papel}.json`);
        await ctx.storageState({ path: arquivo });
        sessoes.set(licao.papel, arquivo);
        await ctx.close();
      }
      // contexto novo por lição: estado de UI de uma lição não vaza para a seguinte
      const ctx = await browser.newContext({
        viewport: { width: LARGURA, height: ALTURA },
        // 1,5×: nítido na foto ampliada e ~100 KB por foto (2× com JPEG 82 dava 97 MB para 408 fotos)
        deviceScaleFactor: 1.5,
        storageState: sessoes.get(licao.papel),
        locale: idioma,
        timezoneId: "America/Sao_Paulo",
      });
      const page = await ctx.newPage();
      const bloquearNotificacoes = modulo.id === "app-no-celular" || modulo.id === "notificacoes";
      if (bloquearNotificacoes) {
        // A aula mostra a permissão bloqueada do Chrome. Configura o navegador
        // de verdade, sem substituir Notification.permission dentro da página.
        const cdp = await ctx.newCDPSession(page);
        const { targetInfo } = await cdp.send("Target.getTargetInfo");
        await cdp.send("Browser.setPermission", {
          permission: { name: "notifications" },
          setting: "denied",
          origin: new URL(URL_BASE).origin,
          browserContextId: targetInfo.browserContextId,
        });
        // O Chrome desfaz o override quando a sessão CDP é desligada.
        // Ela permanece aberta até o fechamento deste contexto ao fim da aula.
      }
      try {
        for (const passo of licao.passos) {
          const chave = chaveDoPasso(modulo.id, licao.id, passo.id);
          try {
            await registrar(chave, async () => {
              if (passo.rota) {
                await page.goto(URL_BASE + passo.rota);
                await page.waitForLoadState("networkidle");
                if (
                  bloquearNotificacoes &&
                  (await page.evaluate(() => Notification.permission)) !== "denied"
                ) {
                  throw new Error(
                    "a permissão real do navegador não reproduz o bloqueio ensinado nesta aula",
                  );
                }
              }
              await page.addStyleTag({ content: CSS_DE_FOTO });
              for (const a of passo.antes) await executar(page, a);
              // As capacidades do agente chegam depois do formulário. Espera
              // esse conteúdo antes de rolar: ele pode empurrar os alvos abaixo.
              await esperarCarregar(page);
              // Percorre o grupo inteiro: um primeiro alvo já visível perto do rodapé
              // não garante que os controles logo abaixo também caibam na foto.
              const alvos = [
                ...passo.destaques.map((d) => d.alvo),
                ...(passo.clicar ? [passo.clicar] : []),
              ];
              let medidas: Pick<Captura, "destaques" | "clicar"> | undefined;
              for (let tentativa = 0; tentativa < 3; tentativa++) {
                for (const alvo of alvos)
                  await localizar(page, alvo).scrollIntoViewIfNeeded({ timeout: 8_000 });
                // Tira o hover, menos quando ele é o que o passo mostra.
                if (passo.antes.at(-1)?.acao !== "hover") await page.mouse.move(0, ALTURA - 1);
                await esperarCarregar(page);
                await tirarFocoDeClique(page);
                await page.waitForTimeout(400);
                try {
                  const destaques = [];
                  for (const d of passo.destaques) {
                    destaques.push({
                      ...(await medir(page, d.alvo)),
                      rotulo: d.rotulo,
                      tipo: d.tipo,
                    });
                  }
                  medidas = {
                    destaques,
                    clicar: passo.clicar ? await medir(page, passo.clicar) : null,
                  };
                  break;
                } catch (erro) {
                  // Conteúdo tardio pode mudar a altura depois da primeira rolagem.
                  // Reenquadra e mede de verdade; nunca repete as ações da aula.
                  if (
                    !(erro instanceof Error) ||
                    !erro.message.startsWith("alvo fora da foto") ||
                    tentativa === 2
                  )
                    throw erro;
                }
              }
              if (!medidas) throw new Error("não foi possível enquadrar os alvos da foto");
              const foto = `capturas/${chave}.jpg`;
              await page.screenshot({ path: path.join(SAIDA, foto), type: "jpeg", quality: 72 });
              return {
                foto,
                ...medidas,
                ...(process.env.CURSO_VERSAO_FOTOS
                  ? { versao: process.env.CURSO_VERSAO_FOTOS.replace(/^v/, "") }
                  : {}),
                capturado_em: new Date().toISOString(),
                idioma,
                commit_fonte: commitDaFoto(),
              };
            });
            console.info(`ok   ${modulo.id}/${chave}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
            falhas.push(`${modulo.id}/${chave}: ${msg}`);
            console.info(`FALHA ${modulo.id}/${chave}: ${msg}`);
            await page
              .screenshot({
                path: path.join(SAIDA, `falha-${chave}.jpg`),
                type: "jpeg",
                quality: 60,
              })
              .catch(() => {});
          }
        }
      } finally {
        if (modulo.id === "api-tokens" && licao.id === "criar-um-token") {
          // A foto mostra o plaintext real de uma chave. Depois de fotografar a lista ativa,
          // revoga pela própria UI; nunca publicar uma credencial que ainda abre a bancada.
          try {
            await page.goto(URL_BASE + "/app/settings/api-tokens");
            await esperarCarregar(page);
            await page
              .getByRole("cell", { name: "Agenda online do site", exact: true })
              .waitFor({ state: "visible", timeout: 8_000 });
            const revogar = page
              .getByRole("row", { name: textoDaInterface("Prontuário eletrônico da clínica") })
              .getByRole("button", { name: textoDaInterface("Revogar"), exact: true });
            if (await revogar.count()) {
              await revogar.click();
              await revogar.waitFor({ state: "detached", timeout: 8_000 });
            }
            const manifesto = JSON.parse(readFileSync(arquivoCapturas, "utf8"));
            manifesto.falhas = manifesto.falhas.filter((f: string) => !f.startsWith("api-tokens:"));
            writeFileSync(arquivoCapturas, JSON.stringify(manifesto, null, 2));
          } catch {
            const erro =
              "api-tokens: não foi possível revogar a chave fotografada — não publique as fotos desta rodada";
            falhas.push(erro);
            abrirManifestoDaRodada(arquivoCapturas, [erro]);
          }
        }
        await ctx.close();
      }
    }
  }
  await browser.close();
  const manifestoFinal = JSON.parse(readFileSync(arquivoCapturas, "utf8"));
  console.info(
    `\n${Object.keys(manifestoFinal.capturas).length} fotos, ${falhas.length} falhas nesta rodada`,
  );
  if (falhas.length) process.exit(1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((e) => {
    console.error(
      e instanceof Error ? e.message.split("\n")[0] : "Falha na captura; confira a bancada local.",
    );
    process.exit(1);
  });
}
