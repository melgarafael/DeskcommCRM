/**
 * CUIDAR DA EQUIPE PELO CELULAR (ADR-0006, fase F4) — medido por geometria.
 *
 * O gestor abre no celular as telas de quem cuida do time: Equipe (membros e
 * convites), a aba Atendimento (plantão e horários), os pedidos de LGPD e as
 * etiquetas. Abaixo de `md` as tabelas viram cartão só com classes `max-md:`
 * (o DOM é o do computador), e as etiquetas, que eram uma `<table>` crua dentro
 * de um `Card` com `overflow-hidden`, perdiam Renomear, Juntar e Excluir pela
 * direita, sem barra de rolagem.
 *
 * ═══ Por que "o <main> não transborda" não basta ═════════════════════════════
 *
 * `components/ui/table.tsx` embrulha toda `<Table>` num `div.overflow-auto`: a
 * tabela larga rola DENTRO dele e nunca alarga o `<main>`. A régua do `<main>`
 * fica verde com ou sem cartão. Então cada cartão tem asserção própria: o
 * `thead` com `display: none`, o invólucro da tabela sem rolagem lateral e a
 * ação com `right <= 390`. As etiquetas não usam o primitivo; ali o que prova é
 * o «Excluir» dentro da tela — e esse caso falha sem o conserto, porque o
 * `Card` corta a tabela.
 *
 * ═══ O que esta spec NÃO cobre, de propósito ═════════════════════════════════
 *
 * A área de toque do interruptor de Disponibilidade (ele desenha 20px). Ela
 * depende do `Switch` com área expandida, que é outro PR da F4; aqui só se
 * prova que o interruptor fica dentro da tela. Também não prova o Safari do
 * iPhone: é Chromium de computador com `isMobile` + `hasTouch`, EMULADO.
 *
 * ═══ Dados ═══════════════════════════════════════════════════════════════════
 *
 * Os membros são os do seed de credenciais (admin, manager, agent, viewer,
 * dono). Pelo service role semeia-se, e apaga-se no fim: um convite pendente
 * cujo e-mail não saiu (o CI não tem Resend), um pedido de LGPD já concluído
 * com vencimento antigo (a lista ordena por vencimento, então ele abre a
 * primeira página) e um contato com uma etiqueta própria. Nada de WAHA.
 *
 * Um login (admin) num caso só: ver `e2e-dois-logins-nao-cabem-no-teto-padrao`.
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, type Locator, type Page } from "./helpers/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { admin, creds, expect, insere, type Creds } from "./qa-l12-comum";

const EVIDENCIA = path.join(process.cwd(), "evidence", "equipe-no-celular-20261023");

/** O piso de alvo de toque, o mesmo de `celular-cabe-na-tela.spec.ts`. */
const PISO_DE_TOQUE = 44;
const LARGURA = 390;

const MARCA = `${Date.now()}`.slice(-7);
const CONVITE = `convite.celular.${MARCA}@um-dominio-bem-comprido-de-teste.com.br`;
/** A tela mostra os 16 primeiros caracteres do sujeito. */
const SUJEITO = `cel-${MARCA}`;
const ETIQUETA = `etq-celular-${MARCA}`;

test.use({ viewport: { width: LARGURA, height: 844 }, hasTouch: true, isMobile: true, locale: "pt-BR" });

async function medir(alvo: Locator) {
  return alvo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, height: r.height };
  });
}

/** O que rola para o lado dentro do <main> do AppShell (o body não enxerga). */
async function rolagemDoMain(page: Page) {
  return page.locator("main").first().evaluate((m) => m.scrollWidth - m.clientWidth);
}

/** O cartão de verdade: cabeçalho fora e o invólucro do primitivo sem rolar. */
async function esperarCartao(tabela: Locator, nome: string) {
  expect(
    await tabela.locator("thead").evaluate((el) => getComputedStyle(el).display),
    `${nome}: o cabeçalho da tabela continua à vista`,
  ).toBe("none");
  const rolagem = await tabela.evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth);
  expect(rolagem, `${nome}: a tabela rola para o lado dentro da própria caixa`).toBeLessThanOrEqual(1);
}

async function esperarAlvoNaTela(alvo: Locator, nome: string) {
  const r = await medir(alvo);
  expect(r.height, `${nome}: altura`).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
  expect(r.width, `${nome}: largura`).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
  expect(r.left, `${nome}: passa da borda esquerda`).toBeGreaterThanOrEqual(0);
  expect(r.right, `${nome}: passa da borda direita`).toBeLessThanOrEqual(LARGURA);
}

test.describe("cuidar da equipe pelo celular", () => {
  test.describe.configure({ timeout: 180_000 });

  let c: Creds;
  let conviteId = "";
  let pedidoId = "";
  let contatoId = "";

  test.beforeAll(async () => {
    lerCreds();
    c = creds();
    conviteId = await insere("team_invites", {
      organization_id: c.org_id,
      email: CONVITE,
      role: "agent",
      email_dispatched: false,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    pedidoId = await insere("lgpd_requests", {
      organization_id: c.org_id,
      request_type: "data_request",
      source: "manual",
      external_customer_id: SUJEITO,
      status: "completed",
      completed_at: new Date().toISOString(),
      due_at: "2001-01-02T12:00:00Z",
    });
    contatoId = await insere("contacts", {
      organization_id: c.org_id,
      name: `Etiqueta Celular ${MARCA}`,
      tags: [ETIQUETA],
    });
  });

  // Nenhuma das três tem filho semeado (o contato não ganha conversa); mesmo
  // assim a ordem é a de filho antes de pai. Cada delete confere o `error` E a
  // linha devolvida: `.delete()` sem linha casada não dá erro, só apaga nada.
  test.afterAll(async () => {
    const falhas: string[] = [];
    for (const [tabela, id] of [
      ["team_invites", conviteId],
      ["lgpd_requests", pedidoId],
      ["contacts", contatoId],
    ] as const) {
      if (!id) continue;
      const { data, error } = await admin.from(tabela).delete().eq("id", id).select("id");
      if (error) falhas.push(`${tabela} ${id}: ${error.message}`);
      else if (data?.length !== 1) falhas.push(`${tabela} ${id}: ${data?.length ?? 0} linha(s) apagada(s)`);
    }
    if (falhas.length > 0) throw new Error(`limpeza da spec não saiu: ${falhas.join("; ")}`);
  });

  test("[P1] equipe, plantão, LGPD e etiquetas cabem a 390px e as ações ficam ao alcance", async ({ page }) => {
    mkdirSync(EVIDENCIA, { recursive: true });
    await loginComoAdmin(page, lerCreds());
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const emailDoAgente = c.users.agent!.email;

    // ── 1. Membros ─────────────────────────────────────────────────────────
    await page.goto("/app/team");
    const painel = page.getByRole("tabpanel");
    const membros = painel.locator("table").first();
    const linhaDoAgente = membros.locator("tbody tr").filter({ hasText: emailDoAgente });
    await expect(linhaDoAgente).toBeVisible({ timeout: 30_000 });
    expect(await rolagemDoMain(page), "membros: o <main> rola para o lado").toBeLessThanOrEqual(1);
    await esperarCartao(membros, "membros");
    await esperarAlvoNaTela(linhaDoAgente.getByRole("button", { name: "Ações" }), "membros: ⋯");

    // ── 2. Convites ────────────────────────────────────────────────────────
    const convites = painel.locator("section").filter({ hasText: "Convites" }).locator("table");
    const linhaDoConvite = convites.locator("tbody tr").filter({ hasText: CONVITE });
    await expect(linhaDoConvite).toBeVisible({ timeout: 30_000 });
    await esperarCartao(convites, "convites");
    await esperarAlvoNaTela(linhaDoConvite.getByRole("button", { name: "Copiar link" }), "convites: Copiar link");
    await esperarAlvoNaTela(linhaDoConvite.getByRole("button", { name: "Ações" }), "convites: ⋯");
    await page.screenshot({ path: path.join(EVIDENCIA, "01-membros-e-convites.png"), fullPage: true });

    // ── 3. Atendimento: plantão e horário ──────────────────────────────────
    // `click`, não `tap`: o gatilho de aba do Radix ativa no `mousedown`.
    await page.getByRole("tab", { name: "Atendimento" }).click();
    await expect(page.getByTestId("atendentes-e-horarios")).toBeVisible({ timeout: 20_000 });
    const atendentes = page.getByRole("tabpanel").locator("table");
    const atendente = atendentes.locator("tbody tr").filter({ hasText: emailDoAgente });
    await expect(atendente).toBeVisible({ timeout: 20_000 });
    expect(await rolagemDoMain(page), "atendimento: o <main> rola para o lado").toBeLessThanOrEqual(1);
    await esperarCartao(atendentes, "atendimento");
    // Só a posição: a área de toque do interruptor é de outro PR (ver o cabeçalho).
    const chave = await medir(atendente.getByRole("switch", { name: /^Disponibilidade de / }));
    expect(chave.left, "o interruptor passa da borda esquerda").toBeGreaterThanOrEqual(0);
    expect(chave.right, "o interruptor passa da borda direita").toBeLessThanOrEqual(LARGURA);
    const editar = atendente.getByRole("button", { name: /^Editar horário de / });
    await esperarAlvoNaTela(editar, "Editar horário");
    await page.screenshot({ path: path.join(EVIDENCIA, "02-atendimento.png"), fullPage: true });

    // O editor de horários: a linha da janela não estoura. Fecha em Cancelar,
    // sem gravar nada.
    await editar.tap();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible();
    if ((await dialogo.getByTestId("janela").count()) === 0) {
      await dialogo.getByRole("button", { name: "Adicionar janela" }).tap();
    }
    const janela = dialogo.getByTestId("janela").first();
    await expect(janela).toBeVisible();
    // Sem a borda direita da LINHA contra a do diálogo: a linha é um flex com a
    // largura do pai, e a caixa dela não cresce quando os filhos transbordam —
    // aquela asserção era verde sempre. Também sem a borda de cada campo contra
    // a do diálogo: o respiro de 24px do diálogo engolia o estouro do 2º campo.
    // Quem acusa é o scrollWidth da linha e a lixeira, o último filho, contra a
    // borda da própria linha. Reprodução aproximada da linha (342px, Chrome 155
    // headless, 2026-10-23): sem `min-w-0` a linha sobra 69px e a lixeira vai a
    // 410px de 342; com o conserto, 0 e 342.
    const caixaDaJanela = await medir(janela);
    expect(await janela.evaluate((el) => el.scrollWidth - el.clientWidth), "a linha da janela estoura").toBeLessThanOrEqual(
      1,
    );
    expect(
      (await medir(janela.getByRole("button", { name: "Remover janela" }))).right,
      "a lixeira passa da borda da linha da janela",
    ).toBeLessThanOrEqual(caixaDaJanela.right + 1);
    // NÃO se mede se o horário aparece inteiro DENTRO do campo. A sonda óbvia,
    // `scrollWidth - clientWidth` no próprio `input[type="time"]`, é morta no
    // Chromium: medido em 2026-10-23 (Chrome 155, headless), um campo de hora
    // com 40px de largura e 16px de respiro de cada lado — corte certo — deu
    // scrollWidth = clientWidth = 36, enquanto o controle, um `type="text"` do
    // mesmo tamanho com texto comprido, deu 157 contra 36. O conteúdo do campo
    // de hora mora no shadow DOM do navegador, fora do alcance da página.
    await page.screenshot({ path: path.join(EVIDENCIA, "03-editor-de-horario.png") });
    await dialogo.getByRole("button", { name: "Cancelar" }).tap();
    await expect(dialogo).toBeHidden();

    // ── 4. Pedidos de LGPD ─────────────────────────────────────────────────
    await page.goto("/app/lgpd/requests");
    const pedidos = page.locator("table").first();
    const pedido = pedidos.locator("tbody tr").filter({ hasText: SUJEITO });
    await expect(pedido).toBeVisible({ timeout: 30_000 });
    expect(await rolagemDoMain(page), "LGPD: o <main> rola para o lado").toBeLessThanOrEqual(1);
    await esperarCartao(pedidos, "LGPD");
    await esperarAlvoNaTela(pedido.getByRole("link", { name: "Ver" }), "LGPD: Ver");
    await page.screenshot({ path: path.join(EVIDENCIA, "04-lgpd.png"), fullPage: true });

    // ── 5. Etiquetas: o bloqueio ───────────────────────────────────────────
    // A tabela de 3 colunas precisa de ~294px (estimativa de leitura, não
    // medida). Com o `p-6` sem prefixo da página, o Card ficava com 308px por
    // dentro (390 − 2×16 do <main> − 2×24 da página − 2×1 da borda): ~14px de
    // folga. Com `md:p-6`, 356px: ~62px.
    await page.goto(`/app/settings/tags?busca=${ETIQUETA}`);
    const etiqueta = page.locator("tbody tr").filter({ hasText: ETIQUETA });
    await expect(etiqueta).toBeVisible({ timeout: 30_000 });
    expect(await rolagemDoMain(page), "etiquetas: o <main> rola para o lado").toBeLessThanOrEqual(1);
    for (const acao of ["Cor", "Renomear", "Juntar", "Excluir"]) {
      const r = await medir(etiqueta.getByRole("button", { name: acao, exact: true }));
      expect(r.right, `etiquetas: «${acao}» cortado pela direita`).toBeLessThanOrEqual(LARGURA);
      expect(r.height, `etiquetas: «${acao}» altura`).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    }
    await page.screenshot({ path: path.join(EVIDENCIA, "05-etiquetas.png"), fullPage: true });

    // ── Controle: no computador as colunas de contagem voltam ──────────────
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("columnheader", { name: "Leads" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Regras de agente" })).toBeVisible();
  });
});
