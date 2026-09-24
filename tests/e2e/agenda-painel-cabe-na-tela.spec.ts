import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { escolherPrimeiroDiaCheio } from "./helpers/agenda-semana-integra";

/**
 * O PAINEL DE MARCAR CABE NA TELA — medido por GEOMETRIA, não por presença.
 *
 * ═══ O defeito ═══════════════════════════════════════════════════════════════
 * O dono do produto abriu a v1.8.0 na VPS, escolheu o dia, e a coluna de
 * horários apareceu FORA do painel, cortada pela borda direita. "Nem zoom out,
 * nem scroll, nem alongar a janela resolve." Não dava para escolher horário
 * nenhum — que é a única coisa que este painel existe para fazer.
 *
 * É aritmética de largura, não responsividade:
 *
 *   contexto  280px  (lg:w-[280px])
 *   calendário 420px  (md:min-w-[420px])
 *   horários  280px  (lg:w-[280px], com md:shrink-0)
 *   ────────────────
 *   ≈ 980px   dentro de um Sheet de `sm:max-w-3xl` = 768px
 *
 * O painel tem `overflow-hidden`, então o excedente é cortado EM SILÊNCIO: sem
 * barra de rolagem, sem aviso, sem como alcançar o que sumiu.
 *
 * ═══ POR QUE ESTA SPEC EXISTE, e a crítica é justa ═══════════════════════════
 * Havia 20 casos Playwright sobre esta tela, e nenhum pegou. Todos assertam
 * PRESENÇA — `toBeVisible()`, `toHaveCount()` — e **elemento cortado continua
 * presente**: ele está no DOM, tem tamanho, e o Playwright o considera visível.
 * A borda que o corta é do PAI.
 *
 * Presença nunca vai medir isto. Só a geometria mede: onde a coluna TERMINA
 * contra onde o painel termina. É a diferença entre "o elemento existe" e "a
 * pessoa consegue usar".
 *
 * ═══ A RÉGUA CERTA, e eu escolhi a errada primeiro ═══════════════════════════
 * Minha primeira versão media "a coluna termina depois do painel". Ela ficou
 * VERMELHA, e eu quase tomei isso por prova. Medindo o estado ESTÁVEL (depois de
 * a animação de `width` terminar), os números são:
 *
 *   viewport   sheet         painel        coluna de horários
 *   1280       512..1280     537..1519     1238..1518
 *   1440       672..1440     697..1679     1398..1678
 *   1920      1152..1920    1177..2159     1878..2158
 *
 * A coluna termina em 1518 e o painel em 1519: **aquela asserção PASSA**. Ela só
 * falhava por medir no meio da transição de `width` — falso vermelho hoje, falso
 * VERDE amanhã, com o produto quebrado igual. Por isso esta spec espera a
 * largura ESTABILIZAR antes de medir.
 *
 * A régua certa é outra, e são duas:
 *   1. o PAINEL cabe no SHEET que o hospeda (982 contra 768 — transborda 214px);
 *   2. a coluna de horários cabe na VIEWPORT (só 42 dos 280px aparecem).
 *
 * ═══ E o defeito NÃO some em tela grande ═════════════════════════════════════
 * Era a previsão, e a medição a derruba: em 1920 o transbordo é idêntico, porque
 * o Sheet é fixo em 768px e ancorado à direita. As três larguras estão aqui não
 * para achar onde o defeito some, mas para provar que ele NÃO some — e para que
 * um conserto que só funcione numa delas seja reprovado nas outras.
 */
const RAIZ = path.resolve(__dirname, "../..");

test.describe.configure({ timeout: 180_000 });

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit", cwd: RAIZ });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  return c;
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

/**
 * Abre o painel e escolhe um dia com horário livre — a coluna de horários só
 * existe depois disso (`data-aberta`), e é ela que transborda.
 */
async function abrirPainelComDiaEscolhido(page: Page, nomeDoTipo: string): Promise<void> {
  await page.goto("/app/agenda");
  await page.getByRole("button", { name: /Novo agendamento/i }).click();
  const painel = page.getByTestId("painel-de-marcacao");
  await expect(painel).toBeVisible({ timeout: 20_000 });

  // ESCOLHER O TIPO DO SEED, e não o primeiro da lista.
  //
  // `page.tsx` ordena os tipos por NOME e o painel abre no primeiro — que nesta
  // organização é "Atendimento", sem jornada publicada. Sem esta linha o painel
  // não oferece dia nenhum, a coluna de horários nunca abre, e a spec falha por
  // FALTA DE CENÁRIO em vez de por geometria: um vermelho que não prova nada
  // sobre o defeito, e que eu quase tomei como prova.
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`^${nomeDoTipo}`) }).click();

  // ⚠️ UM DIA INTEIRO, e NÃO o primeiro clicável — que é HOJE, já meio gasto.
  //
  // A razão medida (9 horários às 15:27 UTC e 7 às 16:37, mesmo commit e mesmo
  // seed) mora com a função, em `helpers/agenda-semana-integra`. Ela está lá e
  // não aqui de propósito: três outras specs de agenda pisaram na mesma pedra no
  // mesmo dia, e a regra só fecha a classe se tiver um dono só.
  await escolherPrimeiroDiaCheio(page);

  const coluna = page.getByTestId("coluna-de-horarios");
  await expect(coluna).toHaveAttribute("data-aberta", "true", { timeout: 15_000 });

  // ⚠️ ESPERAR A LARGURA ESTABILIZAR, e isto não é paciência: a coluna abre com
  // uma transição de `width`, e medir no meio dela dá números que não são de
  // estado nenhum. Foi assim que a primeira versão desta spec ficou vermelha
  // pelo motivo errado — e teria ficado verde, com o produto igualmente
  // quebrado, no dia em que a máquina rodasse um pouco mais devagar.
  await expect(async () => {
    const a = (await coluna.boundingBox())?.width ?? 0;
    await page.waitForTimeout(120);
    const b = (await coluna.boundingBox())?.width ?? 0;
    expect(a, "a largura da coluna ainda está mudando").toBe(b);
    expect(b, "a coluna não chegou a abrir").toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });
}

for (const viewport of [
  // 900 é o EMPILHADO: abaixo de `lg` os horários viram seção sob o calendário.
  // Sem este caso, o conserto poderia quebrar as telas menores sem nada acusar.
  { name: "900×800 (empilhado)", width: 900, height: 800 },
  // 1024 é o LIMIAR, e o caso mais arriscado dos cinco: é onde as três colunas
  // (980px) passam a valer, dentro de um Sheet de 1024 — 44px de folga. Um
  // ajuste de padding em qualquer das colunas estoura aqui primeiro.
  { name: "1024×800 (limiar das 3 colunas)", width: 1024, height: 800 },
  { name: "1280×800 (notebook comum)", width: 1280, height: 800 },
  { name: "1440×900", width: 1440, height: 900 },
  // 1920 está aqui para provar que o defeito NÃO some em tela grande — o Sheet
  // é fixo em 768px e ancorado à direita, então o transbordo é idêntico.
  { name: "1920×1080", width: 1920, height: 1080 },
]) {
  test(`a coluna de horários cabe DENTRO do painel — ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const creds = lerCreds();
    await entrar(page, creds);
    await abrirPainelComDiaEscolhido(page, creds.agenda!.tipo_nome);

    const painel = page.getByTestId("painel-de-marcacao");
    const horarios = page.getByTestId("coluna-de-horarios");
    const sheet = page.locator('[role="dialog"]').first();

    const cxSheet = await sheet.boundingBox();
    const cxPainel = await painel.boundingBox();
    const cxHorarios = await horarios.boundingBox();
    expect(cxSheet, "o Sheet não tem caixa — o painel não está dentro de um diálogo").not.toBeNull();
    expect(cxPainel, "o painel não tem caixa — ele não renderizou").not.toBeNull();
    expect(cxHorarios, "a coluna de horários não tem caixa").not.toBeNull();
    const sh = cxSheet as { x: number; width: number };
    const p = cxPainel as { x: number; width: number };
    const h = cxHorarios as { x: number; width: number };

    // ── RÉGUA 1: o painel cabe no CONTAINER que o hospeda ────────────────────
    // É a conta do defeito: 982px de painel dentro de um Sheet de 768px, com
    // `overflow-hidden` cortando os 214px de diferença EM SILÊNCIO.
    expect(
      p.x + p.width,
      `o painel termina em ${Math.round(p.x + p.width)}px e o Sheet que o hospeda em ` +
        `${Math.round(sh.x + sh.width)}px — ele transborda ${Math.round(p.x + p.width - sh.x - sh.width)}px. ` +
        "O `overflow-hidden` corta sem barra de rolagem: o que passa da borda fica inalcançável.",
    ).toBeLessThanOrEqual(sh.x + sh.width + 1);

    // ── RÉGUA 2: a coluna de horários está DENTRO DA TELA ────────────────────
    // O desfecho para quem usa. Medido no defeito: a coluna começava em 1238px
    // numa janela de 1280 — 42 dos 280px visíveis, o resto fora da tela.
    expect(
      h.x + h.width,
      `a coluna de horários vai até ${Math.round(h.x + h.width)}px, fora de uma janela de ` +
        `${viewport.width}px — só ${Math.round(Math.max(0, viewport.width - h.x))}px dela aparecem. ` +
        "É o que o dono do produto viu: a coluna cortada pela borda direita, sem como alcançá-la.",
    ).toBeLessThanOrEqual(viewport.width + 1);

    // ── RÉGUA 3: caber por não existir não é caber ───────────────────────────
    expect(
      h.width,
      `a coluna cabe mas ficou com ${Math.round(h.width)}px — espremida a ponto de não ` +
        "dar para ler nem clicar num horário",
    ).toBeGreaterThan(100);
  });
}

test("a lista de horários ROLA, e o último horário é alcançável — 1280×700", async ({ page }) => {
  /**
   * O EIXO Y, que esta spec não media.
   *
   * As três réguas acima são todas de largura (`x`, `width`). O dono do produto
   * encontrou o defeito no outro eixo: escolhe o dia, e os últimos horários
   * ficam abaixo da dobra sem nenhum jeito de alcançá-los.
   *
   * A causa é sutil e por isso escapou: o `overflow-y-auto` EXISTE, está no
   * elemento certo, e é INERTE. Um `overflow-y-auto` cujo pai tem altura `auto`
   * não rola — o filho cresce e `scrollHeight === clientHeight`. E a página
   * também não rola, porque o Sheet é `position: fixed` e transbordo de elemento
   * fixo não estende a área rolável do documento.
   *
   * Viewport 700px de altura de propósito: é onde a lista estoura com os 18
   * horários de um dia inteiro da jornada semeada (09:00–17:30, de 30 em 30).
   * "De um dia inteiro" é a parte que este caso já pagou caro: enquanto ele
   * clicava em HOJE, a contagem era o resto do dia e mudava com a hora do run —
   * ver o comentário de `abrirPainelComDiaEscolhido`.
   */
  await page.setViewportSize({ width: 1280, height: 700 });
  const creds = lerCreds();
  await entrar(page, creds);
  await abrirPainelComDiaEscolhido(page, creds.agenda!.tipo_nome);

  const lista = page.getByTestId("lista-de-horarios");
  await expect(lista).toBeVisible({ timeout: 15_000 });
  const horarios = page.locator('[data-testid^="horario-"]');
  const n = await horarios.count();

  // ── PRÉ-CONDIÇÃO DE SUFICIÊNCIA ──────────────────────────────────────────
  // Sem isto o caso fica VERDE POR VACUIDADE no dia em que o cenário produzir
  // poucos slots: uma lista que cabe na tela não precisa rolar, e "não rolou"
  // passaria a ser lido como "está consertado".
  //
  // Ela JÁ COBROU, e cobrou certo: com o dia sendo hoje, reprovou a `main` com 9
  // e depois com 7 horários — recusando-se a passar por um cenário que não
  // exercitava rolagem nenhuma. O conserto foi dar-lhe o cenário (um dia com a
  // jornada inteira), nunca baixar a régua.
  //
  // ⚠️ A RÉGUA É O ESPAÇO QUE SOBRA PARA A LISTA, e não a altura da janela — e
  // eu escrevi errado da primeira vez. Comparar `n * 50` com os 700px da
  // viewport reprovou um cenário SUFICIENTE (13 horários = 650px numa caixa de
  // ~450px transbordam com folga), porque acima da lista ainda há o cabeçalho do
  // Sheet, o título e o padding. O que decide é onde a lista COMEÇA.
  //
  // 50px por item = 44 do `h-11` + 6 do `gap-1.5`.
  const topoDaLista = (await lista.boundingBox())?.y ?? 0;
  const alturaDaJanela = page.viewportSize()?.height ?? 0;
  const espacoQueSobra = alturaDaJanela - topoDaLista;
  expect(
    n * 50,
    `${n} horários ocupam ${n * 50}px e sobram ${Math.round(espacoQueSobra)}px de tela ` +
      "abaixo do topo da lista — ela cabe inteira, e este caso não exercita rolagem " +
      "nenhuma. Sem mais slots no seed, o verde aqui não seria evidência.",
  ).toBeGreaterThan(espacoQueSobra);

  // ── RÉGUA 4: o mecanismo ─────────────────────────────────────────────────
  const medida = await lista.evaluate((el) => ({
    scroll: el.scrollHeight,
    cliente: el.clientHeight,
  }));
  expect(
    medida.scroll,
    `a lista tem ${medida.scroll}px de conteúdo em ${medida.cliente}px de caixa iguais — ` +
      "ela não rola. O `overflow-y-auto` está lá e é inerte porque nenhum ancestral " +
      "define altura: o filho cresce e leva a caixa junto.",
  ).toBeGreaterThan(medida.cliente);

  // ── RÉGUA 5: o desfecho, na língua de quem usa ───────────────────────────
  const ultimo = horarios.last();
  await ultimo.scrollIntoViewIfNeeded();
  await expect(
    ultimo,
    "o último horário não entra na tela nem depois de rolar — é o que o dono viu",
  ).toBeInViewport();
  await ultimo.click();
  await expect(
    page.getByTestId("confirmacao"),
    "cliquei no último horário e o painel não avançou",
  ).toBeVisible({ timeout: 15_000 });

  // ── RÉGUA 6: anti-regressão, e ela NÃO é a que o briefing propôs ─────────
  //
  // A proposta era `document.body.scrollHeight - window.innerHeight <= 1`, com a
  // nota "já passa hoje". **MEDIDO: não passa, e não é culpa do conserto.**
  // Com o painel aberto nesta viewport, o body vai a 1566px contra 700 de
  // janela — e o número é IDÊNTICO com e sem a cadeia de alturas:
  //
  //     COM o conserto:  body 1566 | lista 644 de conteúdo em 396 de caixa
  //     SEM o conserto:  body 1566 | lista 644 de conteúdo em 644 de caixa
  //
  // O crescimento da página é PRÉ-EXISTENTE e independente disto. Asserir sobre
  // ele reprovaria um conserto correto por uma dívida que já estava lá — e foi o
  // que aconteceu na primeira execução, com o conserto no lugar.
  //
  // A propriedade que a régua QUERIA proteger é outra e se mede direto: que o
  // conserto não veio tirando o `position: fixed` do Sheet, que é o que o
  // tornaria um painel comum e faria a página crescer de verdade.
  const posicaoDoSheet = await page
    .locator('[role="dialog"]')
    .first()
    .evaluate((el) => getComputedStyle(el).position);
  expect(
    posicaoDoSheet,
    "o Sheet deixou de ser `fixed` — a rolagem pode até parecer resolvida, mas o " +
      "painel virou conteúdo de página em vez de sobreposição",
  ).toBe("fixed");

  await page.screenshot({ path: "evidence/calendario/d4-lista-rola-1280x700.png", fullPage: false });
});

test("dá para CLICAR num horário — o teste final é a ação, não a medida", async ({ page }) => {
  // A geometria acima é o diagnóstico; isto é o desfecho. Um horário pode estar
  // dentro do painel e ainda assim ser inalcançável (coberto por outra camada,
  // com `pointer-events` bloqueado). O clique atravessa as duas hipóteses.
  await page.setViewportSize({ width: 1280, height: 800 });
  const creds = lerCreds();
  await entrar(page, creds);
  await abrirPainelComDiaEscolhido(page, creds.agenda!.tipo_nome);

  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario, "o dia foi escolhido e nenhum horário apareceu").toBeVisible({
    timeout: 15_000,
  });
  // `timeout` curto de propósito: se o botão estiver fora do alcance, quero a
  // falha rápida e com a mensagem certa, não 150s de espera.
  await horario.click({ timeout: 10_000 });

  await expect(
    page.getByTestId("confirmacao"),
    "cliquei no horário e o painel não avançou para a confirmação",
  ).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: "evidence/calendario/d1-painel-cabe-1280.png", fullPage: false });
});

/**
 * JANELA BAIXA: o formulário rola até o Confirmar, e a marcação GRAVA.
 *
 * De `lg` para cima o Sheet era `lg:overflow-hidden` e o painel só tinha a
 * altura que o formulário acima dele deixava. Em 1280×500 e 1024×560 isso é
 * quase nada: horários e Confirmar ficavam cortados em silêncio. 390×700 é o
 * controle empilhado, onde o Sheet sempre rolou.
 *
 * A roda do mouse, e não `scrollIntoViewIfNeeded`: o clique do Playwright rola
 * até ancestrais com `overflow: hidden` — alcança o que a pessoa não alcança.
 */
for (const viewport of [
  { width: 1024, height: 560 },
  { width: 1280, height: 500 },
  { width: 390, height: 700 },
]) {
  test(`o formulário rola com o mouse até confirmar e grava — ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const creds = lerCreds();
    await entrar(page, creds);
    await abrirPainelComDiaEscolhido(page, creds.agenda!.tipo_nome);
    await page.locator('[data-testid^="horario-"]').first().click({ timeout: 15_000 });

    const dialog = page.getByRole("dialog");
    const confirmar = page.getByTestId("confirmar-marcacao");
    await expect(confirmar).toBeVisible();

    // Volta ao topo e rola com a roda, em passos: um salto único passa do botão
    // no celular, onde o formulário é curto.
    await dialog.evaluate((el) => {
      el.scrollTop = 0;
    });
    const bounds = await dialog.boundingBox();
    if (!bounds) throw new Error("Formulário sem área na tela");
    await page.mouse.move(bounds.x + 8, bounds.y + Math.min(150, bounds.height / 2));
    for (let passo = 0; passo < 20; passo += 1) {
      const botao = await confirmar.boundingBox();
      if (botao && botao.y >= 0 && botao.y + botao.height <= viewport.height) break;
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(100);
    }
    await expect.poll(() => dialog.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(confirmar).toBeInViewport({ ratio: 1 });

    const geometria = await confirmar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const alvo = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { topo: r.top, base: r.bottom, janela: innerHeight, acerta: alvo !== null && el.contains(alvo) };
    });
    expect(geometria.topo).toBeGreaterThanOrEqual(0);
    expect(geometria.base).toBeLessThanOrEqual(geometria.janela);
    expect(geometria.acerta, "o botão está encoberto ou cortado por um ancestral").toBe(true);
    expect(
      await dialog.evaluate((el) => el.scrollWidth - el.clientWidth),
      "nasceu transbordo horizontal no Sheet",
    ).toBeLessThanOrEqual(1);

    fs.mkdirSync("evidence/calendario", { recursive: true });
    await page.screenshot({ path: `evidence/calendario/formulario-confirmar-${viewport.width}x${viewport.height}.png` });

    const gravacao = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/agenda/agendamentos",
    );
    await confirmar.click();
    expect((await gravacao).ok(), "o compromisso precisa ser gravado pelo backend").toBe(true);
    await expect(page.getByText("Marcado.", { exact: true })).toBeVisible();
  });
}
