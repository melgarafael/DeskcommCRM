/**
 * VENDAS E DINHEIRO NO CELULAR (ADR-0006, fase F4) — medido por geometria.
 *
 * Sete telas do gestor que, a 390px, escondiam ação fora da tela ou davam alvo
 * pequeno demais para o dedo. O conserto é só de classes `max-md:`/`sm:` (o DOM
 * é o mesmo do computador). O que esta spec mede, tela a tela:
 *
 * 1. Conexões: o `<main>` não rola para o lado e "Conectar novo WhatsApp" fica
 *    dentro da tela (a fila de botões quebra linha); o link de responsáveis tem
 *    44px. Sem WAHA no CI: só o que aparece sem canal conectado de verdade.
 * 2. Webhooks: as quatro abas ficam visíveis (antes rolavam escondidas dentro da
 *    própria fila) e a borda de cima de cada uma recebe o toque.
 * 3. Radar: "Assumir" fica na tela, o título do item mantém largura legível, e o
 *    link das listas paralelas tem 44px.
 * 4. Propostas: a tabela vira cartão (cabeçalho some, a caixa não rola para o
 *    lado) e o título, que é o link, tem 44px.
 * 5. Detalhe da proposta enviada: aceitar, recusar e revisar ficam na tela.
 * 6. Meta Ads: o `-m-6` acompanha o `p-4` do `<main>` e a página não alarga.
 * 7. Faturamento: "Pagar" e "×" são dois alvos de 44px que não se cobrem, e no
 *    computador voltam ao tamanho de sempre.
 *
 * Por que cada tabela tem asserção própria: a tabela base envolve tudo num
 * `overflow-auto`, e "o `<main>` não transborda" seria verde antes e depois do
 * cartão. A de propostas mede a própria caixa; a de lançamentos é crua (sem a
 * caixa), então ali o `<main>` mede de verdade.
 *
 * Semeia pelo service role (contato, negócio, proposta enviada, demanda sem
 * próximo passo, conta e lançamento pendente), liga o módulo e a capacidade de
 * Propostas só durante a spec, e devolve tudo como achou no `afterAll`.
 * Roda na PARTE_7 (a parte 5 está no limite de tempo).
 *
 * ⚠️ EMULAÇÃO, DECLARADA: Chromium de computador com `isMobile` + `hasTouch`.
 * Prova a regra da tela, não o Safari do iPhone.
 *
 * Um login (admin, porque Conexões é só admin) num caso só.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { test, type Locator, type Page } from "./helpers/test";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

import { admin, creds, expect, insere, type Creds } from "./qa-l12-comum";

/** O piso de alvo de toque, o mesmo de `celular-cabe-na-tela.spec.ts`. */
const PISO_DE_TOQUE = 44;
/** O `<main>` tem `p-4` abaixo de `sm`: o conteúdo mora entre 16 e 374px. */
const BORDA_DIREITA = 375;

const MARCA = `${Date.now()}`.slice(-7);
const CONTATO = `Cliente Comercial ${MARCA}`;
const TITULO = `Proposta de reforma completa da cozinha e da área de serviço ${MARCA}`;
const LANCAMENTO = `Aluguel da sala ${MARCA}`;
const CHAVE_MODULO = "MODULO_PROPOSTAS";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "pt-BR" });

async function medir(alvo: Locator) {
  return alvo.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
  });
}

async function semRolagemNoMain(page: Page, tela: string) {
  const rolagem = await page.locator("main").evaluate((m) => m.scrollWidth - m.clientWidth);
  expect(rolagem, `${tela}: o conteúdo rola para o lado dentro do <main>`).toBeLessThanOrEqual(1);
}

async function dentroDaTela(alvo: Locator, rotulo: string) {
  const r = await medir(alvo);
  expect(r.left, `${rotulo} passa da borda esquerda`).toBeGreaterThanOrEqual(15);
  expect(r.right, `${rotulo} passa da borda direita`).toBeLessThanOrEqual(BORDA_DIREITA);
}

test.describe("vendas e dinheiro no celular", () => {
  test.describe.configure({ timeout: 300_000 });

  let c: Creds;
  let moduloAntes: string | null = null;
  let propostasAntes: unknown;
  const ids = { contato: "", negocio: "", proposta: "", demanda: "", conta: "", lancamento: "" };

  test.beforeAll(async () => {
    c = creds();

    // O radar de `scripts/seed-e2e-radar.ts`: um negócio frio com conversa sem
    // dono, que é o que faz o botão "Assumir" aparecer. Idempotente.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-radar.ts"], { stdio: "inherit" });

    // Propostas é módulo da instalação E capacidade da organização: as duas
    // chaves ligadas, guardando o estado de antes para devolver.
    const modulo = await admin.from("platform_config").select("valor").eq("chave", CHAVE_MODULO).maybeSingle();
    if (modulo.error) throw modulo.error;
    moduloAntes = (modulo.data?.valor as string | null) ?? null;
    const ligar = await admin
      .from("platform_config")
      .upsert({ chave: CHAVE_MODULO, valor: "ligado", eh_segredo: false, semeado_do_env: false }, { onConflict: "chave" });
    if (ligar.error) throw ligar.error;

    const org = await admin.from("organizations").select("settings").eq("id", c.org_id).single();
    if (org.error) throw org.error;
    const settings = (org.data.settings ?? {}) as Record<string, unknown>;
    propostasAntes = settings.proposals;
    const anterior = (settings.proposals ?? {}) as Record<string, unknown>;
    const capacidade = await admin
      .from("organizations")
      .update({ settings: { ...settings, proposals: { ...anterior, enabled: true } } })
      .eq("id", c.org_id);
    if (capacidade.error) throw capacidade.error;

    const funil = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", c.org_id)
      .eq("is_default", true)
      .single();
    if (funil.error) throw funil.error;
    const etapa = await admin
      .from("crm_stages")
      .select("id")
      .eq("pipeline_id", funil.data.id)
      .eq("is_archived", false)
      .order("position")
      .limit(1)
      .single();
    if (etapa.error) throw etapa.error;

    ids.contato = await insere("contacts", { organization_id: c.org_id, name: CONTATO, tags: [] });
    ids.negocio = await insere("crm_leads", {
      organization_id: c.org_id,
      pipeline_id: funil.data.id,
      stage_id: etapa.data.id,
      contact_id: ids.contato,
      title: `Negócio ${MARCA}`,
      position_in_stage: 9000,
      source: "manual",
    });
    ids.proposta = await insere("crm_proposals", {
      organization_id: c.org_id,
      lead_id: ids.negocio,
      contact_id: ids.contato,
      status: "enviada",
      titulo: TITULO,
      total_cents: 1_250_000,
      numero: 9000 + (Number(MARCA) % 999),
      ano: 2026,
      sent_at: new Date().toISOString(),
    });
    // Aberta há 30 dias: vai para o topo da lista "sem próximo passo".
    ids.demanda = await insere("demandas", {
      organization_id: c.org_id,
      contact_id: ids.contato,
      lead_id: ids.negocio,
      origem: "manual",
      aberta_em: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
    });
    ids.conta = await insere("financial_accounts", { organization_id: c.org_id, name: `Caixa ${MARCA}` });
    // Sem `entry_date`: o padrão é o dia de hoje, dentro do período que a tela abre.
    ids.lancamento = await insere("financial_entries", {
      organization_id: c.org_id,
      account_id: ids.conta,
      direction: "out",
      amount_cents: 120_000,
      description: LANCAMENTO,
      status: "pending",
      origin: "manual",
    });
  });

  test.afterAll(async () => {
    // Cada passo roda mesmo que o anterior falhe, e o que falhou é cobrado no
    // fim: limpeza que engole erro deixa dado de teste para trás calada.
    const erros: string[] = [];
    const confere = (passo: string, res: { error: { message: string } | null }) => {
      if (res.error) erros.push(`${passo}: ${res.error.message}`);
    };

    // Filhos antes de pais: o lançamento prende a conta (`on delete restrict`),
    // e demanda e proposta apontam para o negócio, que aponta para o contato.
    if (ids.lancamento) confere("apagar lançamento", await admin.from("financial_entries").delete().eq("id", ids.lancamento));
    if (ids.conta) confere("apagar conta", await admin.from("financial_accounts").delete().eq("id", ids.conta));
    if (ids.demanda) confere("apagar demanda", await admin.from("demandas").delete().eq("id", ids.demanda));
    if (ids.proposta) confere("apagar proposta", await admin.from("crm_proposals").delete().eq("id", ids.proposta));
    if (ids.negocio) confere("apagar negócio", await admin.from("crm_leads").delete().eq("id", ids.negocio));
    if (ids.contato) confere("apagar contato", await admin.from("contacts").delete().eq("id", ids.contato));

    const org = await admin.from("organizations").select("settings").eq("id", c.org_id).single();
    confere("ler organizations.settings para devolver", org);
    if (!org.error) {
      const { proposals: _ligada, ...resto } = (org.data.settings ?? {}) as Record<string, unknown>;
      const devolvida = propostasAntes === undefined ? resto : { ...resto, proposals: propostasAntes };
      confere("devolver organizations.settings", await admin.from("organizations").update({ settings: devolvida }).eq("id", c.org_id));
    }
    if (moduloAntes === null) {
      confere("devolver platform_config", await admin.from("platform_config").delete().eq("chave", CHAVE_MODULO));
    } else {
      confere(
        "devolver platform_config",
        await admin
          .from("platform_config")
          .upsert({ chave: CHAVE_MODULO, valor: moduloAntes, eh_segredo: false, semeado_do_env: false }, { onConflict: "chave" }),
      );
    }

    if (erros.length > 0) throw new Error(`a limpeza da spec deixou dado para trás:\n${erros.join("\n")}`);
  });

  test("[P1] o gestor alcança cada ação de vendas e dinheiro no celular", async ({ page }, info) => {
    await loginComoAdmin(page, lerCreds());
    // Sem toque emulado as classes de ponteiro grosso não valeriam.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const foto = async (nome: string) =>
      info.attach(nome, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

    // 1. Conexões.
    await page.goto("/app/connections");
    const conectar = page.getByRole("button", { name: "Conectar novo WhatsApp" });
    await expect(conectar).toBeVisible({ timeout: 30_000 });
    await semRolagemNoMain(page, "Conexões");
    await dentroDaTela(conectar, "Conectar novo WhatsApp");
    await dentroDaTela(page.getByRole("button", { name: "Agendar pausa" }), "Agendar pausa");
    const responsaveis = page.getByRole("link", { name: "Configurar responsáveis por número" });
    expect((await medir(responsaveis)).height, "link de responsáveis").toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    await foto("01-conexoes");

    // 2. Webhooks: as quatro abas na tela, nenhuma rolando escondida.
    await page.goto("/app/webhooks");
    const fila = page.getByRole("tablist").first();
    await expect(fila.getByRole("tab")).toHaveCount(4, { timeout: 30_000 });
    expect(await fila.evaluate((el) => el.scrollWidth - el.clientWidth), "a fila de abas rola por dentro").toBeLessThanOrEqual(1);
    for (const aba of await fila.getByRole("tab").all()) {
      const nome = (await aba.textContent()) ?? "aba";
      await dentroDaTela(aba, nome);
      // A borda de cima recebe o toque: a fila não recorta a aba de 44px.
      //
      // DESVIO DE MÉTODO, DECLARADO: o toque é sondado a 3px da borda de cima,
      // não no meio da aba (21px). Antes do conserto a fila tinha `h-9` com
      // `overflow-x-auto` (que recorta também na vertical) e só 28px úteis; a
      // aba de 44px, centrada, sobrava 8px para cima e 8px para baixo, numa
      // faixa recortada que o dedo não alcança. O meio da aba acerta antes E
      // depois do conserto, então não separaria os dois; 3px cai dentro da
      // faixa recortada de antes.
      //
      // Controle negativo: 1px ACIMA da aba o mesmo `elementFromPoint` NÃO pode
      // devolver a aba. Sem ele, uma sonda que acertasse a aba em qualquer
      // ponto passaria verde aqui sem provar nada sobre a borda.
      const toque = await aba.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const ehAba = (alvo: Element | null) => alvo !== null && (alvo === el || el.contains(alvo));
        return { borda: ehAba(document.elementFromPoint(x, r.top + 3)), acima: ehAba(document.elementFromPoint(x, r.top - 1)) };
      });
      expect(toque.acima, `${nome}: controle — 1px acima da aba ainda acerta a aba`).toBe(false);
      expect(toque.borda, `${nome}: a borda de cima não recebe o toque`).toBe(true);
    }
    await semRolagemNoMain(page, "Webhooks");
    await foto("02-webhooks");

    // 3. Radar.
    await page.goto("/app/radar");
    const radar = JSON.parse(readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as {
      radar: { at_risk_title: string };
    };
    const item = page.getByTestId("radar-item").filter({ hasText: radar.radar.at_risk_title });
    await expect(item).toBeVisible({ timeout: 30_000 });
    await dentroDaTela(item.getByTestId("radar-claim"), "Assumir");
    const titulo = item.getByText(radar.radar.at_risk_title, { exact: true });
    expect((await medir(titulo)).width, "o título do item espremido pelos botões").toBeGreaterThanOrEqual(150);
    const semPasso = page.getByTestId("radar-sem-passo-link").first();
    await expect(semPasso).toBeVisible();
    expect((await medir(semPasso)).height, "link da lista sem próximo passo").toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    await semRolagemNoMain(page, "Radar");
    await foto("03-radar");

    // 4. Lista de propostas em cartão.
    await page.goto("/app/proposals");
    const linkDaProposta = page.getByRole("link", { name: TITULO });
    await expect(linkDaProposta).toBeVisible({ timeout: 30_000 });
    expect(await page.locator("thead").evaluate((el) => getComputedStyle(el).display)).toBe("none");
    const caixa = await page
      .locator("table")
      .evaluate((tabela) => tabela.parentElement!.scrollWidth - tabela.parentElement!.clientWidth);
    expect(caixa, "a caixa da tabela de propostas rola para o lado").toBeLessThanOrEqual(1);
    // A altura da PRIMEIRA caixa do link, não a do retângulo inteiro: sem o
    // conserto o link é `inline` numa coluna estreita, o título longo quebra em
    // várias linhas e o `getBoundingClientRect` somaria todas (passaria de
    // 44px sem alvo nenhum de 44px). Inline, a primeira caixa é uma linha de
    // texto (~20px); com `max-md:flex max-md:min-h-11` ela é a caixa do link.
    const primeiraCaixa = await linkDaProposta.evaluate((el) => el.getClientRects()[0]?.height ?? 0);
    expect(primeiraCaixa, "a caixa do link do título da proposta").toBeGreaterThanOrEqual(PISO_DE_TOQUE);
    expect((await medir(linkDaProposta)).right).toBeLessThanOrEqual(BORDA_DIREITA);
    await semRolagemNoMain(page, "Propostas");
    await foto("04-propostas");

    // 5. Detalhe da proposta enviada.
    await page.goto(`/app/proposals/${ids.proposta}`);
    const aceitar = page.getByRole("button", { name: "Marcar como aceita" });
    await expect(aceitar).toBeVisible({ timeout: 30_000 });
    for (const rotulo of ["Marcar como aceita", "Marcar como recusada", "Revisar esta proposta"]) {
      await dentroDaTela(page.getByRole("button", { name: rotulo }), rotulo);
    }
    await semRolagemNoMain(page, "Detalhe da proposta");
    await foto("05-proposta-enviada");

    // 6. Meta Ads, sem conta conectada.
    await page.goto("/app/ads/meta");
    await expect(page.getByRole("heading", { name: "Meta Ads" })).toBeVisible({ timeout: 30_000 });
    await semRolagemNoMain(page, "Meta Ads");
    await foto("06-meta-ads");

    // 7. Faturamento: Pagar e × lado a lado, cada um com 44px, sem se cobrir.
    await page.goto("/app/faturamento");
    const pagar = page.getByTestId(`pagar-${ids.lancamento}`);
    await expect(pagar).toBeVisible({ timeout: 30_000 });
    const linha = page.locator("tr").filter({ has: pagar });
    expect(await linha.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
    const remover = linha.getByRole("button", { name: "Remover lançamento" });
    const p = await medir(pagar);
    const x = await medir(remover);
    for (const [rotulo, caixaDoBotao] of [["Pagar", p], ["×", x]] as const) {
      expect(caixaDoBotao.height, `${rotulo}: altura`).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
      expect(caixaDoBotao.width, `${rotulo}: largura`).toBeGreaterThanOrEqual(PISO_DE_TOQUE);
      expect(caixaDoBotao.right, `${rotulo}: fora da tela`).toBeLessThanOrEqual(BORDA_DIREITA);
    }
    expect(p.right, "Pagar invade o ×").toBeLessThanOrEqual(x.left);
    await semRolagemNoMain(page, "Faturamento");
    await foto("07-faturamento");

    // Controle: no computador, a linha é a de sempre e os botões voltam a texto.
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await linha.evaluate((el) => getComputedStyle(el).display)).toBe("table-row");
    expect((await medir(pagar)).height, "Pagar no computador").toBeLessThan(PISO_DE_TOQUE);
  });
});
