/**
 * AS ABAS DE CONVERSÕES CABEM NA LARGURA DO CELULAR — medido, não fotografado.
 *
 * ## O defeito que esta spec prende (#5224)
 *
 * A 375 px, a barra de abas de `/app/settings/conversoes` era um `nav` com
 * `flex` e mais nada. Os quatro links (`px-3 py-2 text-sm`) não encolhem abaixo
 * do próprio texto, e "Links rastreáveis" empurrava a barra para fora da caixa:
 * o contêiner da própria tela (`div.flex.h-full.flex-col.overflow-y-auto.p-6`)
 * passava a rolar PARA O LADO — `scrollWidth` 419 contra `clientWidth` 343, com
 * a quarta aba terminando em x = 435.
 *
 * ## Onde medir, e por que não no `documentElement`
 *
 * `documentElement.scrollWidth` dá ZERO aqui mesmo com o defeito no lugar:
 * `app/globals.css` põe `overflow-x: hidden`/`clip` em `html` e `body`, e sob
 * `hidden` o `scrollWidth` é grampeado no `clientWidth` — a mesma armadilha
 * documentada em `celular-cabe-na-tela.spec.ts`. Quem rola é o `<div>` interno
 * da tela, então é nele que a conta acontece.
 *
 * A barra e as abas são achadas pelo CONTRATO (`?aba=links` na quarta), não pelo
 * rótulo: o rótulo muda com o idioma, o contrato não.
 *
 * ## Por que os dois idiomas
 *
 * "Enlaces rastreables" é mais largo que "Links rastreáveis". Um conserto que
 * caiba só em português é meio conserto — em espanhol a barra volta a estourar.
 * O caso de espanhol confere o rótulo espanhol ANTES de medir, para não passar
 * medindo português por engano.
 *
 * ## A régua
 *
 * Duas contas, e nenhuma delas é "parece bem": (1) o contêiner não passa da
 * própria largura (`scrollWidth - clientWidth <= 1`); (2) as QUATRO abas ficam
 * inteiras dentro da caixa visível — sem rolagem lateral nenhuma, nem no
 * contêiner nem na barra. Uma barra que "só rola" reprova em (2), que é o que a
 * issue pede: as abas têm de estar à vista, não escondidas atrás de um gesto.
 *
 * Desktop (1024 px) mede o mesmo, e confere que a barra continua numa linha só:
 * o conserto não pode trocar o defeito do celular por uma barra quebrada no
 * computador.
 */
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { test, expect, type Page } from "./helpers/test";
import { trocarIdiomaPelaTela } from "./helpers/idioma";
import { lerCreds, loginComoDono } from "./helpers/login-admin";

/** Um login só para todos os casos: dois caem na mesma janela TOTP. */
test.describe.configure({ timeout: 180_000 });

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

/**
 * O retrato da barra, em px.
 *
 * `caixa` é o `<div>` que rola (o pai do `nav`); `abas` são os quatro links com
 * a borda direita de cada um. `folga` é o quanto a aba mais à direita passa da
 * borda útil da caixa — o número que a issue mede, e o que tem de ficar em 0.
 */
type Retrato = {
  janela: number;
  caixa: { scroll: number; client: number; left: number; right: number };
  barra: { scroll: number; client: number; topo: number; base: number; altura: number };
  abas: { rotulo: string; left: number; right: number; topo: number }[];
  folga: number;
  transbordo: number;
  detalhe: string;
};

async function medirBarra(page: Page): Promise<Retrato> {
  return page.evaluate(() => {
    const quarta = document.querySelector<HTMLElement>('a[href="?aba=links"]');
    if (!quarta) throw new Error('a quarta aba (`a[href="?aba=links"]`) não está na tela');
    const barra = quarta.closest("nav");
    if (!barra) throw new Error("a quarta aba não está dentro de um `nav`");
    const caixa = barra.parentElement;
    if (!caixa) throw new Error("o `nav` das abas não tem contêiner");

    const rc = caixa.getBoundingClientRect();
    const rb = barra.getBoundingClientRect();
    const abas = Array.from(barra.querySelectorAll("a")).map((a) => {
      const r = a.getBoundingClientRect();
      return {
        rotulo: (a.textContent ?? "").trim(),
        left: Math.round(r.left * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        topo: Math.round(r.top * 10) / 10,
      };
    });
    // A borda útil da caixa é onde o conteúdo visível termina; a aba que passa
    // dela está cortada, mesmo que o `overflow-x` do pai seja `auto`.
    const folga = Math.max(0, ...abas.map((a) => a.right - rc.right));
    const transbordo = caixa.scrollWidth - caixa.clientWidth;
    return {
      janela: document.documentElement.clientWidth,
      caixa: {
        scroll: caixa.scrollWidth,
        client: caixa.clientWidth,
        left: Math.round(rc.left * 10) / 10,
        right: Math.round(rc.right * 10) / 10,
      },
      barra: {
        scroll: barra.scrollWidth,
        client: barra.clientWidth,
        topo: Math.round(rb.top * 10) / 10,
        base: Math.round(rb.bottom * 10) / 10,
        altura: Math.round(rb.height * 10) / 10,
      },
      abas,
      folga: Math.round(folga * 10) / 10,
      transbordo,
      detalhe:
        `janela=${document.documentElement.clientWidth} ` +
        `caixa=${caixa.scrollWidth}/${caixa.clientWidth} ` +
        `barra=${barra.scrollWidth}/${barra.clientWidth} ` +
        `folga=${Math.round(folga * 10) / 10}px ` +
        `abas=[${abas.map((a) => `${a.rotulo}:${a.left}..${a.right}`).join(" | ")}]`,
    };
  });
}

/**
 * Mede depois que a largura PARA de mudar.
 *
 * Aberta há pouco, a tela ainda está revelando (o streaming do Next monta
 * pedaços em sequência); medir no meio disso dá "falso vermelho hoje, falso
 * verde amanhã". Duas leituras iguais seguidas é o sinal de que assentou.
 */
async function medirEstavel(page: Page): Promise<Retrato> {
  let anterior = Number.NaN;
  for (let i = 0; i < 20; i++) {
    const medida = await medirBarra(page);
    const agora = medida.transbordo * 1000 + medida.folga;
    if (agora === anterior) return medida;
    anterior = agora;
    await page.waitForTimeout(150);
  }
  return medirBarra(page);
}

async function abrirConversoes(page: Page) {
  await page.goto("/app/settings/conversoes", { waitUntil: "domcontentloaded" });
  // A tela montou quando a barra de abas está lá — é ela que este caso mede.
  await expect(
    page.locator('a[href="?aba=links"]'),
    "a tela de conversões não montou: a quarta aba não apareceu",
  ).toBeVisible({ timeout: 60_000 });
}

test.afterAll(async () => {
  // ⚠️ A conta do `dono` é COMPARTILHADA com a suíte inteira, e a preferência de
  // idioma vive no banco. Se este caso falhar no meio, ele deixaria o `dono` em
  // espanhol e arrastaria toda spec que procura rótulo em português depois dele.
  // A restauração vai DIRETO AO BANCO (se a falha foi na tela, restaurar pela
  // tela falharia junto) e devolve `null`, que é a ausência de preferência — o
  // jeito como a conta nasce do seed.
  const c = credenciaisSupabaseDeTeste();
  const svc = createClient(c.url, c.serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = lerCreds().users.dono!.email;
  const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  const dono = data?.users.find((u) => u.email === email);
  if (!dono) throw new Error(`restauração: não achei ${email} para devolver o idioma`);
  const { error } = await svc.auth.admin.updateUserById(dono.id, {
    user_metadata: { ...dono.user_metadata, locale: null },
  });
  if (error) throw new Error(`restauração do idioma falhou: ${error.message}`);
});

test("as quatro abas de conversões cabem em 375px, em português e em espanhol", async ({
  page,
}, testInfo) => {
  await loginComoDono(page, lerCreds());

  // ── Português ────────────────────────────────────────────────────────────
  await abrirConversoes(page);
  const pt = await medirEstavel(page);
  testInfo.annotations.push({ type: "medida", description: `pt-BR 375px: ${pt.detalhe}` });
  expect(pt.detalhe).toContain("Links rastreáveis");

  expect(
    pt.transbordo,
    `o painel de conversões rola para o lado em 375px — ${pt.detalhe}`,
  ).toBeLessThanOrEqual(1);
  expect(
    pt.folga,
    `a quarta aba passa da caixa visível em 375px — ${pt.detalhe}`,
  ).toBeLessThanOrEqual(1);
  for (const aba of pt.abas) {
    expect(
      aba.left,
      `a aba "${aba.rotulo}" começa fora da caixa em 375px — ${pt.detalhe}`,
    ).toBeGreaterThanOrEqual(pt.caixa.left - 1);
  }
  expect(pt.abas, "a barra não tem as quatro abas").toHaveLength(4);

  // ── Espanhol: "Enlaces rastreables" é MAIS LARGO que "Links rastreáveis" ──
  await trocarIdiomaPelaTela(page, "es");
  await abrirConversoes(page);
  const es = await medirEstavel(page);
  testInfo.annotations.push({ type: "medida", description: `es 375px: ${es.detalhe}` });
  // Controle positivo: se o idioma não trocou, o resto desta metade mediria
  // português e passaria sem provar nada.
  expect(
    es.abas.map((a) => a.rotulo).join(" | "),
    "a tela não passou para o espanhol: os rótulos continuam em português",
  ).toContain("Enlaces rastreables");

  expect(
    es.transbordo,
    `o painel de conversões rola para o lado em 375px, em espanhol — ${es.detalhe}`,
  ).toBeLessThanOrEqual(1);
  expect(
    es.folga,
    `a quarta aba passa da caixa visível em 375px, em espanhol — ${es.detalhe}`,
  ).toBeLessThanOrEqual(1);
  for (const aba of es.abas) {
    expect(
      aba.left,
      `a aba "${aba.rotulo}" começa fora da caixa em 375px, em espanhol — ${es.detalhe}`,
    ).toBeGreaterThanOrEqual(es.caixa.left - 1);
  }

  // ── Desktop (1024): nada muda, e a barra segue numa linha só ────────────
  await page.setViewportSize({ width: 1024, height: 800 });
  await abrirConversoes(page);
  const desktop = await medirEstavel(page);
  testInfo.annotations.push({
    type: "medida",
    description: `es 1024px: ${desktop.detalhe}`,
  });
  expect(
    desktop.transbordo,
    `a tela de conversões rola para o lado em 1024px — ${desktop.detalhe}`,
  ).toBeLessThanOrEqual(1);
  const topos = new Set(desktop.abas.map((a) => a.topo));
  expect(
    topos.size,
    `em 1024px as abas quebraram em mais de uma linha — ${desktop.detalhe}`,
  ).toBe(1);
});
