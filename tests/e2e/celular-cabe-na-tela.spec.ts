/**
 * O CELULAR CABE NA TELA — medido por GEOMETRIA, não por presença.
 *
 * ═══ Por que esta spec existe ════════════════════════════════════════════════
 *
 * `docs/design-system/screen-flow/07-responsive-strategy.md` declara os
 * princípios do celular desde 28/04/2026 — `100dvh`, área segura, alvo de
 * 44px — e quase nenhum deles existia em código. A entrega que os implementou
 * precisa de uma cerca, porque regressão de layout é invisível em teste de
 * presença: `toBeVisible()` passa em elemento CORTADO, que está no DOM, tem
 * tamanho e é considerado visível pelo Playwright. A borda que o corta é do PAI.
 * Vinte casos na tela do painel de marcação não pegaram exatamente esse defeito
 * (`agenda-painel-cabe-na-tela.spec.ts`).
 *
 * ═══ A régua, e ela tem uma armadilha de uma linha ═══════════════════════════
 *
 * `document.body.scrollWidth - document.documentElement.clientWidth`.
 *
 * NUNCA `documentElement.scrollWidth`. `app/globals.css` põe `overflow-x: hidden`
 * seguido de `clip` em `html` E em `body`, e sob `hidden` (que é a reserva para
 * motor sem `clip`) o `scrollWidth` do documentElement é GRAMPEADO no
 * `clientWidth`: a conta dá ZERO com um filho de 3000px. Está registrado em
 * `app/globals.css`, no bloco da coluna de horários da agenda — ali o gate dava
 * zero enquanto o usuário perdia metade da tela.
 *
 * Consequência que vale repetir: neste produto um estouro horizontal não produz
 * barra de rolagem. O conteúdo simplesmente SOME pela direita, sem aviso e sem
 * jeito de alcançá-lo. É por isso que a medida tem de ser explícita.
 *
 * ═══ Três casos, e o motivo de não serem onze ════════════════════════════════
 *
 * A primeira versão tinha um `test` por combinação (4 superfícies × 2 larguras,
 * mais os outros): onze logins. `tests/unit/e2e-dois-logins-nao-cabem-no-teto-padrao.test.ts`
 * reprovou, e com razão — o helper de login guarda o último código TOTP e, se o
 * login seguinte cai na MESMA janela de 30s, ele espera a próxima para não
 * repetir o código. Onze logins são até dez esperas dessas, e o veredito que
 * chega ao log é `Test timeout`, que se lê como tela travada.
 *
 * A correção é estrutural e não cosmética: as oito combinações viraram UM caso
 * que percorre as duas larguras e as quatro superfícies com um login só. O teto
 * declarado abaixo cobre o login (mais a janela TOTP, no pior caso) e as oito
 * navegações.
 *
 * ═══ Espera estabilizar, e isto passou a importar mais ═══════════════════════
 *
 * A entrega acrescentou animação a todos os sobrepostos do produto (gaveta,
 * modal, menu, seletor, dica — eram ~24 classes que não geravam CSS nenhum).
 * Medir no meio de uma transição dá "falso vermelho hoje, falso verde amanhã",
 * com o produto quebrado igual. Então as medições abaixo esperam a largura do
 * `body` PARAR de mudar.
 *
 * ═══ O que esta spec NÃO prova ═══════════════════════════════════════════════
 *
 * Que está bonito. Ela prova que cabe, que o dedo alcança e que o rodapé
 * reserva — três perguntas de régua. A prova de aparência é a evidência visual
 * de `evidence/celular-quase-nativo-20261005/`, citada em
 * `evidence/celular-quase-nativo-20261005/LEIA.md`.
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const EVIDENCE = path.join(process.cwd(), "evidence", "celular-quase-nativo-20261005");
mkdirSync(EVIDENCE, { recursive: true });

/**
 * O teto por caso. O piso que o gate cobra é o padrão do Playwright mais uma
 * janela TOTP inteira (30s + 30s); o dobro disso é o que cabe, além do login, as
 * oito navegações do primeiro caso.
 */
test.describe.configure({ timeout: 120_000 });

/** O piso de alvo de toque da Apple HIG, adotado pelo princípio 4 da estratégia. */
const PISO_DE_TOQUE = 44;

/**
 * As larguras. 360 é o piso da faixa `mobile` declarada na estratégia
 * (360–767) e é onde a casa já mediu defeito real; 390 é o iPhone 12/13/14, a
 * largura mais comum e a que as outras ~20 specs do repo usam.
 */
const LARGURAS = [360, 390] as const;

/**
 * As quatro superfícies que alguém abre no celular. `/admin/**` fica fora por
 * doutrina própria (princípio 6: super-admin não otimiza para celular).
 */
const SUPERFICIES = [
  { rota: "/app/inbox", nome: "inbox" },
  { rota: "/app/kanban", nome: "funis" },
  { rota: "/app/agenda", nome: "agenda" },
  { rota: "/app/metrics", nome: "painel" },
] as const;

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Espera a largura do `body` parar de mudar — fim das transições. */
async function estabilizar(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const janela = window as unknown as { __larguraAnterior?: number; __quietos?: number };
      const agora = document.body.scrollWidth;
      if (janela.__larguraAnterior === agora) {
        janela.__quietos = (janela.__quietos ?? 0) + 1;
      } else {
        janela.__quietos = 0;
        janela.__larguraAnterior = agora;
      }
      return (janela.__quietos ?? 0) >= 3;
    },
    undefined,
    { timeout: 15_000, polling: 120 },
  );
}

async function abrir(page: Page, rota: string): Promise<void> {
  await page.goto(rota);
  await page.waitForLoadState("networkidle").catch(() => {});
  await estabilizar(page);
}

/**
 * A reserva publicada no `<html>` e o que o `<main>` desconta de verdade.
 *
 * As três leituras juntas, e não só a variável: `--rodape-ocupado` é o número que
 * o contrato publica, `data-rodape-ocupado` é o mesmo número pelo atributo (o
 * jsdom não computa `var()`, é por ali que o resto da suíte mede), e
 * `padding-bottom` calculado é o que a PESSOA vê — `max(24px, env(...), var(...))`.
 * Uma variável certa com o `padding-bottom` preso continuaria sendo o defeito.
 */
async function medirODescontoDoRodape(page: Page) {
  return page.evaluate(() => {
    const principal = document.querySelector<HTMLElement>("main");
    const barra = document.querySelector<HTMLElement>("nav[data-barra-inferior]");
    return {
      variavel: document.documentElement.style.getPropertyValue("--rodape-ocupado").trim(),
      atributo: principal?.dataset.rodapeOcupado ?? null,
      descontado: principal ? Math.round(parseFloat(getComputedStyle(principal).paddingBottom)) : -1,
      alturaDaBarra: barra ? Math.round(barra.getBoundingClientRect().height) : -1,
    };
  });
}

/**
 * Espera o rodapé ACOMODAR — e o valor esperado NÃO entra aqui de propósito.
 *
 * Esperar pelo valor que se quer medir seria fé: o `waitForFunction` retornaria
 * no instante em que o valor aparecesse, e o `expect` seguinte provaria a espera,
 * não o produto. O que esta espera exige é outra coisa: três leituras iguais e ao
 * menos 600 ms desde a última mudança. O `ResizeObserver` avisa o hook no quadro
 * seguinte ao `setViewportSize`, então medir antes disso mediria o estado
 * ANTERIOR à transição — falso vermelho numa direção e falso verde na outra.
 */
async function esperarORodapeAcomodar(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const janela = window as unknown as { __rodape?: string; __quieto?: number; __desde?: number };
      const agora = document.documentElement.style.getPropertyValue("--rodape-ocupado").trim();
      if (janela.__rodape !== agora) {
        janela.__rodape = agora;
        janela.__quieto = 0;
        janela.__desde = Date.now();
      } else {
        janela.__quieto = (janela.__quieto ?? 0) + 1;
      }
      return (janela.__quieto ?? 0) >= 3 && Date.now() - (janela.__desde ?? Date.now()) >= 600;
    },
    undefined,
    { timeout: 15_000, polling: 120 },
  );
}

const creds = lerCreds();

test("as quatro superfícies não estouram a tela em 360 nem em 390px", async ({ page }) => {
  await loginComoAdmin(page, creds);

  const estouros: string[] = [];
  for (const largura of LARGURAS) {
    await page.setViewportSize({ width: largura, height: 844 });
    for (const { rota, nome } of SUPERFICIES) {
      await abrir(page, rota);
      const { body, janela } = await page.evaluate(() => ({
        // ⚠️ `body.scrollWidth`, NUNCA `documentElement.scrollWidth` — ver o
        // cabeçalho deste arquivo. A escolha errada aqui faz o gate medir zero.
        body: document.body.scrollWidth,
        janela: document.documentElement.clientWidth,
      }));
      await page.screenshot({ path: path.join(EVIDENCE, `${largura}-${nome}.png`) });
      // Tolerância de 1px para arredondamento de subpixel, e não mais: o defeito
      // que isto pega mede dezenas ou centenas de pixels (476px na tela do
      // agente, 214px no painel da agenda).
      if (body - janela > 1) estouros.push(`${rota} em ${largura}px: ${body} > ${janela}`);
    }
  }

  expect(
    estouros,
    "o excedente NÃO ganha barra de rolagem neste produto (overflow-x: clip): ele some pela direita",
  ).toEqual([]);
});

test("nenhum controle do painel fica abaixo de 44px de altura em 360px", async ({ page }) => {
  // O PAINEL, e não as quatro superfícies, e o motivo é honestidade de régua.
  //
  // Na medição desta entrega o painel fechou em ZERO controles curtos, e é a
  // única das quatro em que isso é verdade — então é a única em que uma
  // asserção de "nenhum" não nasce com exceção. Nas outras três sobram casos
  // LEGÍTIMOS que esta régua acusaria: links de texto dentro de lista no funil
  // (um link de 21px de altura não é alvo de 44px, é texto), e as células de
  // meia hora da agenda, cuja densidade é decisão registrada em
  // `components/agenda/GradeDaAgenda.tsx` ("sete colunas em 360px dão ~44px
  // cada, e a célula de meia hora vira um alvo de ~44x24").
  //
  // Um gate que nasce com três exceções ensina a ignorar o gate. Este nasce com
  // uma superfície limpa e uma catraca: se o painel regredir, reprova.
  await loginComoAdmin(page, creds);
  await page.setViewportSize({ width: 360, height: 844 });
  await abrir(page, "/app/metrics");

  const curtos = await page.evaluate((piso) => {
    const fora: Array<{ marca: string; texto: string; w: number; h: number }> = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      'a[href], button, [role="button"], input, select, textarea',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const estilo = getComputedStyle(el);
      if (estilo.visibility === "hidden" || estilo.display === "none") continue;
      // Link de TEXTO dentro de parágrafo ou lista não é alvo de 44px: ele é
      // texto, e a régua da HIG é para controle. Reconhecido por não ter fundo
      // próprio.
      if (el.tagName === "A" && estilo.backgroundColor === "rgba(0, 0, 0, 0)") continue;
      if (r.height >= piso) continue;
      fora.push({
        marca: el.tagName.toLowerCase(),
        texto: (el.textContent ?? "").trim().slice(0, 30),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    return fora;
  }, PISO_DE_TOQUE);

  expect(
    curtos,
    `controles com menos de ${PISO_DE_TOQUE}px de ALTURA em 360px — ` +
      `princípio 4 de docs/design-system/screen-flow/07-responsive-strategy.md`,
  ).toEqual([]);
});

test("a barra de abas ocupa rodapé no celular e NADA no desktop", async ({ page }) => {
  await loginComoAdmin(page, creds);

  // ── no celular: existe, encosta no fundo, e o conteúdo desconta ────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await abrir(page, "/app/kanban");

  await expect(page.locator("nav[data-barra-inferior]")).toBeVisible();
  const noCelular = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>("nav[data-barra-inferior]");
    const principal = document.querySelector<HTMLElement>("main");
    if (!nav || !principal) return null;
    const r = nav.getBoundingClientRect();
    return {
      altura: Math.round(r.height),
      folgaAteOFundo: Math.round(window.innerHeight - r.bottom),
      descontado: Math.round(parseFloat(getComputedStyle(principal).paddingBottom)),
    };
  });

  expect(noCelular).not.toBeNull();
  // Encosta no fundo: é barra de abas, não painel flutuante.
  expect(noCelular!.folgaAteOFundo).toBe(0);
  expect(noCelular!.altura).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
  // E o `<main>` desconta pelo menos o que ela mede. É o contrato de
  // `lib/ui/rodape-ocupado.tsx` fechando o laço: sem ele, o fim de toda lista
  // ficava POR BAIXO das abas — o defeito da #1305 numa peça nova.
  expect(noCelular!.descontado).toBeGreaterThanOrEqual(noCelular!.altura);

  // ── no desktop: some, e o rodapé NÃO perde faixa por ela ───────────────────
  //
  // O CONTROLE NEGATIVO, e ele pega um defeito que existiu antes de a medição
  // acontecer: a barra é escondida por CSS (`md:hidden`), então no laptop ela
  // continua no DOM. Enquanto declarava `altura: 56` como piso, o contrato
  // reservava 56px de rodapé numa tela em que a barra não aparece — e o Inbox e
  // o quadro do funil, que leem a mesma variável para calcular a própria
  // altura, encolhiam junto. Hoje a `altura` declarada é 0 e quem decide é a
  // medição, que devolve zero para elemento escondido.
  await page.setViewportSize({ width: 1440, height: 900 });
  await abrir(page, "/app/kanban");

  await expect(page.locator("nav[data-barra-inferior]")).toBeHidden();
  const reserva = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--rodape-ocupado").trim(),
  );
  expect(reserva === "" || reserva === "0px").toBe(true);
});

/**
 * A TRANSIÇÃO NA MESMA PÁGINA — o caso que o teste de cima NÃO mede.
 *
 * ═══ O buraco do caso anterior, medido ═══════════════════════════════════════
 *
 * O caso de `:203` alarga para 1440 e chama `abrir(page, "/app/kanban")`, que é
 * um `page.goto` (`:119`): recarrega. Mede a PRIMEIRA carga no desktop, que
 * sempre funcionou — a barra nasce escondida, mede zero e a reserva fica em zero.
 * A transição estreito → largo na mesma página nunca foi medida, e é justamente
 * onde o defeito mora: com uma medida positiva já guardada (54 px, a barra à
 * vista), o `ResizeObserver` entrega o zero do `display: none` e o hook o
 * descarta. `--rodape-ocupado` fica preso em 54 px e o `<main>` desconta 54 px de
 * rodapé para uma barra que não está na tela — 30 px vazios, e o Inbox e o funil,
 * que leem a mesma variável, encolhem junto.
 *
 * ═══ Por que a régua é o `padding-bottom` calculado ══════════════════════════
 *
 * A variável é o número que o contrato publica; o `padding-bottom` é o que a
 * pessoa perde. Medir só a variável deixaria passar uma casca que publica `0px` e
 * continua descontando `54px` por outra via — `max(24px, env(...), var(...))` é a
 * expressão de verdade, e é ela que este caso calcula no navegador.
 *
 * ═══ Sem `goto` e sem `reload` entre as duas medidas ═════════════════════════
 *
 * É a condição que faz este caso medir a transição: qualquer recarga zeraria o
 * `alturaMedida` do hook, que é exatamente o que o defeito precisa que exista.
 */
test("ao alargar a janela SEM recarregar, a barra que sai de vista devolve o rodapé ao piso", async ({
  page,
}) => {
  await loginComoAdmin(page, creds);

  // ── ESTREITO: a barra está à vista e a reserva é o que ela mede ────────────
  await page.setViewportSize({ width: 390, height: 844 });
  await abrir(page, "/app/kanban");
  await expect(page.locator("nav[data-barra-inferior]")).toBeVisible();
  await esperarORodapeAcomodar(page);

  const estreito = await medirODescontoDoRodape(page);
  expect(estreito.alturaDaBarra, "a barra de abas não está à vista em 390px").toBeGreaterThanOrEqual(
    PISO_DE_TOQUE,
  );
  // CONTROLE (o mesmo do caso de cima): estreito, a reserva continua valendo o
  // que a barra mede, e o `<main>` desconta pelo menos isso.
  expect(estreito.variavel).toBe(`${estreito.alturaDaBarra}px`);
  expect(estreito.descontado).toBeGreaterThanOrEqual(estreito.alturaDaBarra);

  // ── ALARGA A MESMA PÁGINA — sem `abrir`, sem `goto`, sem `reload` ──────────
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("nav[data-barra-inferior]")).toBeHidden();
  await esperarORodapeAcomodar(page);

  const largo = await medirODescontoDoRodape(page);
  // A barra saiu de vista: a medida dela é zero e o hook tem de gravar esse zero.
  expect(largo.alturaDaBarra).toBe(0);
  expect(
    largo.variavel === "" || largo.variavel === "0px",
    `--rodape-ocupado ficou preso em ${largo.variavel || "(vazio)"} depois de a barra sair de vista`,
  ).toBe(true);
  expect(largo.atributo, "o <main> continua descontando a barra que sumiu").toBe("0");
  // E o que a pessoa vê: o piso do `p-6` da casca, não os 54px da barra.
  expect(largo.descontado).toBe(24);

  // As quatro medidas das duas larguras no log do run: é o número que o artefato
  // da issue cita (variável, atributo, `padding-bottom` calculado e a altura da
  // barra), e sem ele o verde não diria QUANTO foi medido.
  // eslint-disable-next-line no-console
  console.log(`[rodape-3061] estreito=${JSON.stringify(estreito)} largo=${JSON.stringify(largo)}`);
});
