/**
 * O FILTRO POR MARCADOR, PROVADO PELA TELA — Inbox (#1206) e funil (#1208).
 *
 * Os dois PRs consertaram o filtro para ler as DUAS caixas de marcador (a da
 * conversa e a do contato), e as provas deles foram pela rota (`page.request`)
 * e por teste unitário. Nenhuma prova clicava: marcar pelo editor, abrir o
 * seletor, ver o marcador lá e filtrar até achar. É o que o operador faz, e é
 * onde mora o defeito que só a tela mostra: o vocabulário do seletor fica em
 * cache (`staleTime` de 5 min) e só é relido se quem grava mandar reler.
 *
 * Por isso, depois de marcar, NADA aqui recarrega a página do Inbox: a
 * navegação entre as conversas é pela busca e por clique. Um `page.goto`
 * depois de marcar zeraria o cache e esconderia exatamente o defeito.
 *
 *  · Inbox: marca uma conversa pelo editor da CONVERSA e outra pelo do
 *    CONTATO; o seletor oferece os dois (a união dos vocabulários) e cada
 *    marcador filtra até a conversa certa, sem trazer a outra nem a neutra.
 *  · Funil: marca o contato em "Tags do contato" e a conversa em "Tags da
 *    conversa", no Inbox; no quadro, os DOIS marcadores aparecem no seletor e
 *    cada um filtra até o card (a conversa entrou no filtro por decisão do
 *    dono, doc 40, 19/09 — este caso dizia o contrário até então). Controle
 *    negativo: o card neutro nunca aparece filtrado.
 */
import { randomInt, randomUUID } from "node:crypto";

import { test, type Page } from "@playwright/test";

import {
  abreConversa,
  abreQuadro,
  admin,
  captura,
  creds,
  expect,
  insere,
  login,
  registra,
  type Creds,
} from "./qa-l12-comum";

const SUFIXO = `${Date.now()}`.slice(-7);

let c: Creds;
let canal = "";
const conversas: string[] = [];
const contatos: string[] = [];
let funil = "";

/** Cria contato + conversa aberta + uma mensagem de entrada (a lista precisa dela). */
async function conversaDe(nome: string): Promise<{ contato: string; conversa: string }> {
  const contato = await insere("contacts", {
    organization_id: c.org_id,
    name: nome,
    phone_number: `+5511${randomInt(100000000, 1000000000)}`,
    tags: [],
  });
  const conversa = await insere("conversations", {
    organization_id: c.org_id,
    contact_id: contato,
    channel_session_id: canal,
    status: "open",
    tags: [],
  });
  await insere("messages", {
    organization_id: c.org_id,
    contact_id: contato,
    conversation_id: conversa,
    channel_session_id: canal,
    direction: "inbound",
    type: "text",
    status: "received",
    body: `Olá, aqui é ${nome}`,
    sent_at: new Date().toISOString(),
  });
  contatos.push(contato);
  conversas.push(conversa);
  return { contato, conversa };
}

/**
 * O item da conversa NA LISTA, pelo id. Pelo nome casaria também o painel da
 * conversa aberta, e o "não está na lista" daria falso vermelho.
 */
const itemDaLista = (page: Page, conversaId: string) =>
  page.locator(`button[data-conversation-id="${conversaId}"]`);

/** Marca pelo campo de um dos editores e espera o PATCH voltar 200. */
async function marcar(page: Page, campo: string, rota: string, tag: string): Promise<void> {
  const resposta = page.waitForResponse(
    (r) => r.url().includes(rota) && r.request().method() === "PATCH",
  );
  const entrada = page.getByLabel(campo);
  await entrada.fill(tag);
  await entrada.press("Enter");
  const r = await resposta;
  registra(`filtro-pela-tela · PATCH ${rota} (${tag}) = ${r.status()}`);
  expect(r.status(), `gravar "${tag}" pelo campo "${campo}"`).toBe(200);
}

/** Troca de conversa SEM recarregar: busca pelo nome e clica no item. */
async function irPelaLista(page: Page, nome: string, conversaId: string): Promise<void> {
  const busca = page.getByLabel("Buscar conversas");
  await busca.fill(nome);
  await itemDaLista(page, conversaId).click();
  await expect(itemDaLista(page, conversaId)).toHaveAttribute("aria-current", "true");
  await busca.fill("");
}

test.describe("filtro por marcador, pela tela", () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    c = creds();
    canal = await insere("channel_sessions", {
      organization_id: c.org_id,
      waha_session_name: `qa-filtro-tela-${randomUUID()}`,
      display_name: "Canal QA filtro por marcador",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
  });

  test.afterAll(async () => {
    if (conversas.length) await admin.from("conversations").delete().in("id", conversas);
    if (funil) await admin.from("crm_pipelines").delete().eq("id", funil);
    if (contatos.length) await admin.from("contacts").delete().in("id", contatos);
    if (canal) await admin.from("channel_sessions").delete().eq("id", canal);
  });

  test("Inbox (#1206): o seletor oferece as duas caixas e cada marcador acha a sua conversa", async ({
    page,
  }) => {
    const nomeConversa = `Filtro Conversa ${SUFIXO}`;
    const nomeContato = `Filtro Contato ${SUFIXO}`;
    const nomeNeutro = `Filtro Neutro ${SUFIXO}`;
    const tagDaConversa = `retorno-${SUFIXO}`;
    const tagDoContato = `vip-${SUFIXO}`;

    const a = await conversaDe(nomeConversa);
    const b = await conversaDe(nomeContato);
    const n = await conversaDe(nomeNeutro);

    // ── EXPERIMENTO (não é conserto): instrumentação, para ser revertida ──────
    //
    // O caso morre no clique da linha ~166 com o call log de UMA linha
    // ("waiting for"), 300s: o locator NUNCA resolve. Duas linhas antes ele
    // resolveu. Entre as duas só roda o `captura()`. As medições já feitas
    // (trace do run 35465018832) descartaram a rede: ZERO chamada de API entre
    // mono=122200 e mono=123200, e zero status >= 400 nas 157 do caso.
    //
    // O que falta é o instante EXATO em que a opção sai do DOM e quem a tira.
    // Amostrar a cada 100 ms erraria uma janela de ~85 ms; um MutationObserver
    // não erra — ele grava a remoção no momento em que ela acontece. Os
    // `frame-snapshot` do trace NÃO servem para isso: são incrementais, e
    // ausência neles não é medição (um deles marca o menu como fechado num
    // instante em que ele comprovadamente estava aberto).
    const erros: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") erros.push(`console.error :: ${m.text().slice(0, 200)}`);
    });
    page.on("response", (r) => {
      if (r.status() >= 400) erros.push(`HTTP ${r.status()} :: ${r.url().slice(0, 140)}`);
    });
    page.on("requestfailed", (r) => {
      erros.push(`requestfailed :: ${r.url().slice(0, 140)} :: ${r.failure()?.errorText ?? "?"}`);
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __filtro?: string[] };
      w.__filtro = [];
      const conta = () => document.querySelectorAll('[role="option"]').length;
      // Teto: o painel da conversa re-renderiza a cada 4s (`ReplyReviewPanel`
      // tem `refetchInterval: 4000`, e isso é da BASE, não desta branch — 72
      // chamadas medidas no trace). Sem teto, o filme vira ruído e o log do job
      // fica ilegível.
      const marca = (verbo: string, alvo: string) =>
        w.__filtro!.length < 400 &&
        w.__filtro!.push(
          `${performance.now().toFixed(0)}ms ${verbo} ${alvo} | listbox=${
            document.querySelectorAll('[role="listbox"]').length
          } options=${conta()} altura=${document.body.scrollHeight} viewport=${window.innerHeight}`,
        );
      const interessa = (nó: Node): string | null => {
        if (!(nó instanceof Element)) return null;
        const papel = nó.getAttribute("role");
        if (papel === "option" || papel === "listbox") return `${papel}:${nó.textContent?.trim().slice(0, 40) ?? ""}`;
        const dentro = nó.querySelector('[role="listbox"], [role="option"]');
        return dentro ? `ancestral-de:${dentro.getAttribute("role")}` : null;
      };
      new MutationObserver((lista) => {
        for (const m of lista) {
          for (const nó of m.removedNodes) {
            const q = interessa(nó);
            if (q) marca("SAIU", q);
          }
          for (const nó of m.addedNodes) {
            const q = interessa(nó);
            if (q) marca("entrou", q);
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener("resize", () => marca("resize", `${window.innerWidth}x${window.innerHeight}`));
      document.addEventListener("focusin", (e) =>
        marca("focusin", (e.target as Element)?.tagName ?? "?"), true);
    });

    await login(page, c.users.manager!.email, c.password);
    await abreConversa(page, a.conversa);
    await page.getByRole("tab", { name: /^Todas/ }).click();

    // 1. Caixa da CONVERSA, pelo editor da conversa.
    await marcar(page, "Adicionar tag à conversa", `/conversations/${a.conversa}`, tagDaConversa);

    // 2. Caixa do CONTATO, noutra conversa — sem recarregar.
    await irPelaLista(page, nomeContato, b.conversa);
    await page.getByRole("button", { name: "Tags do contato", exact: true }).click();
    await marcar(page, "Adicionar tag ao contato", "/contacts/", tagDoContato);

    // 3. O seletor oferece a UNIÃO dos dois vocabulários.
    const seletor = page.getByRole("combobox", { name: "Filtrar por tag" });
    await seletor.click();
    await expect(page.getByRole("option", { name: tagDaConversa, exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("option", { name: tagDoContato, exact: true })).toBeVisible();

    // ── EXPERIMENTO: o cerco ao `captura()` ───────────────────────────────────
    // `fullPage: true` redimensiona a viewport para a ALTURA DO DOCUMENTO. Esta
    // branch acrescenta uma seção ao painel lateral (`LeadEnrichment`, visível
    // na screenshot da falha como "Sobre a empresa"), então a página ficou mais
    // alta — e o resize é a única coisa que roda entre o locator resolver e o
    // clique. Medir ANTES e DEPOIS separa "o screenshot é o gatilho" de "a
    // opção já tinha saído antes dele", que é a bifurcação que um bit não dá.
    const olha = async (marco: string) => {
      const s = await page.evaluate(() => ({
        listbox: document.querySelectorAll('[role="listbox"]').length,
        opcoes: [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? ""),
        altura: document.body.scrollHeight,
        viewport: window.innerHeight,
      }));
      registra(
        `filtro-instrumento · ${marco} · listbox=${s.listbox} opcoes=[${s.opcoes.join("|")}] altura=${s.altura} viewport=${s.viewport}`,
      );
    };
    await olha("antes-do-screenshot");
    await captura(page, "filtro-tela-01-inbox-uniao-dos-vocabularios");
    await olha("depois-do-screenshot");

    // 4. O marcador do CONTATO acha a conversa dele — e só ela.
    // Teto curto de propósito: o caso já morreu aqui por 300s uma vez, e esperar
    // de novo custa 5 min de CI para reimprimir o mesmo timeout. O que interessa
    // agora é o filme, despejado logo abaixo.
    try {
      await page
        .getByRole("option", { name: tagDoContato, exact: true })
        .click({ timeout: 15_000 });
      registra("filtro-instrumento · clique OK");
    } catch (e) {
      registra(`filtro-instrumento · clique FALHOU :: ${(e as Error).message.split("\n")[0]}`);
    }
    const filme = await page.evaluate(
      () => (window as unknown as { __filtro?: string[] }).__filtro ?? [],
    );
    registra(`filtro-instrumento · FILME (${filme.length} mutações, últimas 80):`);
    for (const linha of filme.slice(-80)) registra(`filtro-instrumento ·   ${linha}`);
    registra(`filtro-instrumento · ERROS (${erros.length}):`);
    for (const linha of erros) registra(`filtro-instrumento ·   ${linha}`);
    await olha("depois-do-clique");
    await expect(itemDaLista(page, b.conversa)).toBeVisible({ timeout: 30_000 });
    await expect(itemDaLista(page, a.conversa)).toHaveCount(0);
    await expect(itemDaLista(page, n.conversa)).toHaveCount(0);
    await captura(page, "filtro-tela-02-inbox-pelo-contato");

    // 5. O marcador da CONVERSA acha a outra — e só ela.
    await seletor.click();
    await page.getByRole("option", { name: tagDaConversa, exact: true }).click();
    await expect(itemDaLista(page, a.conversa)).toBeVisible({ timeout: 30_000 });
    await expect(itemDaLista(page, b.conversa)).toHaveCount(0);
    await expect(itemDaLista(page, n.conversa)).toHaveCount(0);
    await captura(page, "filtro-tela-03-inbox-pela-conversa");
  });

  // ── EXPERIMENTO: a ABLAÇÃO do caso acima ────────────────────────────────
  //
  // Idêntico ao caso A em tudo, MENOS uma linha: aqui o `captura()` NÃO roda
  // entre o locator resolver e o clique — ele foi movido para depois. Se B
  // passar e A falhar no MESMO run, o screenshot `fullPage` está provado como
  // a causa, por diferença, sem depender de alguém interpretar o filme do
  // MutationObserver. Se B falhar junto, a hipótese morre no mesmo ciclo.
  //
  // `fullPage: true` redimensiona a viewport para a ALTURA DO DOCUMENTO, e o
  // Radix fecha o popover em resize. Esta branch acrescenta `LeadEnrichment`
  // ao painel lateral — a página ficou mais alta que na base, onde o mesmo
  // caso passa em 11,1s.
  test("ABLAÇÃO (experimento): o mesmo caso SEM o captura() antes do clique", async ({
    page,
  }) => {
    const nomeConversa = `Filtro Conversa ${SUFIXO}b`;
    const nomeContato = `Filtro Contato ${SUFIXO}b`;
    const nomeNeutro = `Filtro Neutro ${SUFIXO}b`;
    const tagDaConversa = `retorno-${SUFIXO}b`;
    const tagDoContato = `vip-${SUFIXO}b`;

    const a = await conversaDe(nomeConversa);
    const b = await conversaDe(nomeContato);
    const n = await conversaDe(nomeNeutro);

    // ── EXPERIMENTO (não é conserto): instrumentação, para ser revertida ──────
    //
    // O caso morre no clique da linha ~166 com o call log de UMA linha
    // ("waiting for"), 300s: o locator NUNCA resolve. Duas linhas antes ele
    // resolveu. Entre as duas só roda o `captura()`. As medições já feitas
    // (trace do run 35465018832) descartaram a rede: ZERO chamada de API entre
    // mono=122200 e mono=123200, e zero status >= 400 nas 157 do caso.
    //
    // O que falta é o instante EXATO em que a opção sai do DOM e quem a tira.
    // Amostrar a cada 100 ms erraria uma janela de ~85 ms; um MutationObserver
    // não erra — ele grava a remoção no momento em que ela acontece. Os
    // `frame-snapshot` do trace NÃO servem para isso: são incrementais, e
    // ausência neles não é medição (um deles marca o menu como fechado num
    // instante em que ele comprovadamente estava aberto).
    const erros: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") erros.push(`console.error :: ${m.text().slice(0, 200)}`);
    });
    page.on("response", (r) => {
      if (r.status() >= 400) erros.push(`HTTP ${r.status()} :: ${r.url().slice(0, 140)}`);
    });
    page.on("requestfailed", (r) => {
      erros.push(`requestfailed :: ${r.url().slice(0, 140)} :: ${r.failure()?.errorText ?? "?"}`);
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __filtro?: string[] };
      w.__filtro = [];
      const conta = () => document.querySelectorAll('[role="option"]').length;
      // Teto: o painel da conversa re-renderiza a cada 4s (`ReplyReviewPanel`
      // tem `refetchInterval: 4000`, e isso é da BASE, não desta branch — 72
      // chamadas medidas no trace). Sem teto, o filme vira ruído e o log do job
      // fica ilegível.
      const marca = (verbo: string, alvo: string) =>
        w.__filtro!.length < 400 &&
        w.__filtro!.push(
          `${performance.now().toFixed(0)}ms ${verbo} ${alvo} | listbox=${
            document.querySelectorAll('[role="listbox"]').length
          } options=${conta()} altura=${document.body.scrollHeight} viewport=${window.innerHeight}`,
        );
      const interessa = (nó: Node): string | null => {
        if (!(nó instanceof Element)) return null;
        const papel = nó.getAttribute("role");
        if (papel === "option" || papel === "listbox") return `${papel}:${nó.textContent?.trim().slice(0, 40) ?? ""}`;
        const dentro = nó.querySelector('[role="listbox"], [role="option"]');
        return dentro ? `ancestral-de:${dentro.getAttribute("role")}` : null;
      };
      new MutationObserver((lista) => {
        for (const m of lista) {
          for (const nó of m.removedNodes) {
            const q = interessa(nó);
            if (q) marca("SAIU", q);
          }
          for (const nó of m.addedNodes) {
            const q = interessa(nó);
            if (q) marca("entrou", q);
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener("resize", () => marca("resize", `${window.innerWidth}x${window.innerHeight}`));
      document.addEventListener("focusin", (e) =>
        marca("focusin", (e.target as Element)?.tagName ?? "?"), true);
    });

    await login(page, c.users.manager!.email, c.password);
    await abreConversa(page, a.conversa);
    await page.getByRole("tab", { name: /^Todas/ }).click();

    // 1. Caixa da CONVERSA, pelo editor da conversa.
    await marcar(page, "Adicionar tag à conversa", `/conversations/${a.conversa}`, tagDaConversa);

    // 2. Caixa do CONTATO, noutra conversa — sem recarregar.
    await irPelaLista(page, nomeContato, b.conversa);
    await page.getByRole("button", { name: "Tags do contato", exact: true }).click();
    await marcar(page, "Adicionar tag ao contato", "/contacts/", tagDoContato);

    // 3. O seletor oferece a UNIÃO dos dois vocabulários.
    const seletor = page.getByRole("combobox", { name: "Filtrar por tag" });
    await seletor.click();
    await expect(page.getByRole("option", { name: tagDaConversa, exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("option", { name: tagDoContato, exact: true })).toBeVisible();

    // ── EXPERIMENTO: o mesmo olhar do caso A, sem o screenshot no meio ───────
    // O caso A mede ANTES e DEPOIS do `captura()`. Aqui não há `captura()` no
    // ponto, então há uma leitura só — e é ela que diz se a opção continua na
    // lista quando nada redimensiona a viewport.
    const olha = async (marco: string) => {
      const s = await page.evaluate(() => ({
        listbox: document.querySelectorAll('[role="listbox"]').length,
        opcoes: [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? ""),
        altura: document.body.scrollHeight,
        viewport: window.innerHeight,
      }));
      registra(
        `ablacao-instrumento · ${marco} · listbox=${s.listbox} opcoes=[${s.opcoes.join("|")}] altura=${s.altura} viewport=${s.viewport}`,
      );
    };
    // ← A ABLAÇÃO: nenhuma screenshot aqui. É a ÚNICA diferença para o caso A.
    await olha("sem-screenshot-no-ponto-critico");

    // 4. O marcador do CONTATO acha a conversa dele — e só ela.
    // Teto curto de propósito: o caso já morreu aqui por 300s uma vez, e esperar
    // de novo custa 5 min de CI para reimprimir o mesmo timeout. O que interessa
    // agora é o filme, despejado logo abaixo.
    // O `catch` aqui NÃO engole: ele só adia, para o filme abaixo ser despejado
    // antes de o caso morrer. Engolir de verdade abriria o pior desfecho deste
    // experimento — B VERDE SEM TER EXERCITADO NADA, que se lê como prova e não
    // é. Verde de B tem de significar "o clique aconteceu", e só o re-lance no
    // fim garante isso.
    let falhaDoClique: Error | null = null;
    try {
      await page
        .getByRole("option", { name: tagDoContato, exact: true })
        .click({ timeout: 15_000 });
      registra("ablacao-instrumento · clique OK");
    } catch (e) {
      falhaDoClique = e as Error;
      registra(`ablacao-instrumento · clique FALHOU :: ${falhaDoClique.message.split("\n")[0]}`);
    }
    const filme = await page.evaluate(
      () => (window as unknown as { __filtro?: string[] }).__filtro ?? [],
    );
    registra(`ablacao-instrumento · FILME (${filme.length} mutações, últimas 80):`);
    for (const linha of filme.slice(-80)) registra(`ablacao-instrumento ·   ${linha}`);
    registra(`ablacao-instrumento · ERROS (${erros.length}):`);
    for (const linha of erros) registra(`ablacao-instrumento ·   ${linha}`);
    await olha("depois-do-clique");
    await captura(page, "ablacao-filtro-tela-01-uniao-dos-vocabularios-tardia");
    if (falhaDoClique) throw falhaDoClique;
    await expect(itemDaLista(page, b.conversa)).toBeVisible({ timeout: 30_000 });
    await expect(itemDaLista(page, a.conversa)).toHaveCount(0);
    await expect(itemDaLista(page, n.conversa)).toHaveCount(0);
    await captura(page, "ablacao-filtro-tela-02-inbox-pelo-contato");

    // 5. O marcador da CONVERSA acha a outra — e só ela.
    await seletor.click();
    await page.getByRole("option", { name: tagDaConversa, exact: true }).click();
    await expect(itemDaLista(page, a.conversa)).toBeVisible({ timeout: 30_000 });
    await expect(itemDaLista(page, b.conversa)).toHaveCount(0);
    await expect(itemDaLista(page, n.conversa)).toHaveCount(0);
    await captura(page, "ablacao-filtro-tela-03-inbox-pela-conversa");
  });

  test("Funil (#1208): o marcador do contato E o da conversa filtram o quadro", async ({
    page,
  }) => {
    const nome = `Filtro Funil ${SUFIXO}`;
    const cardMarcado = `Card Marcado ${SUFIXO}`;
    const cardNeutro = `Card Neutro ${SUFIXO}`;
    const tagDoContato = `obra-${SUFIXO}`;
    const soNaConversa = `so-conversa-${SUFIXO}`;

    const alvo = await conversaDe(nome);
    const neutro = await conversaDe(`Filtro Funil Neutro ${SUFIXO}`);

    funil = await insere("crm_pipelines", {
      organization_id: c.org_id,
      name: `Funil filtro por marcador ${SUFIXO}`,
      slug: `qa-filtro-tela-${SUFIXO}`,
    });
    const etapa = await insere("crm_stages", {
      organization_id: c.org_id,
      pipeline_id: funil,
      name: "Contato feito",
      slug: `contato-${SUFIXO}`,
      position: 1000,
    });
    for (const [titulo, contato, posicao] of [
      [cardMarcado, alvo.contato, 1000],
      [cardNeutro, neutro.contato, 2000],
    ] as [string, string, number][]) {
      await insere("crm_leads", {
        organization_id: c.org_id,
        pipeline_id: funil,
        stage_id: etapa,
        contact_id: contato,
        title: titulo,
        position_in_stage: posicao,
        source: "manual",
      });
    }

    // Marca pelo Inbox: a PESSOA em "Tags do contato", e a CONVERSA à parte.
    await login(page, c.users.manager!.email, c.password);
    await abreConversa(page, alvo.conversa);
    await page.getByRole("button", { name: "Tags do contato", exact: true }).click();
    await marcar(page, "Adicionar tag ao contato", "/contacts/", tagDoContato);
    await marcar(page, "Adicionar tag à conversa", `/conversations/${alvo.conversa}`, soNaConversa);

    // O quadro, com os dois cards.
    await abreQuadro(page, funil, cardMarcado);
    await expect(page.getByRole("group", { name: `Lead: ${cardNeutro}` })).toBeVisible();

    await page.getByRole("button", { name: "Tag: todas" }).click();
    await expect(page.getByRole("menuitem", { name: tagDoContato, exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // O da CONVERSA também é oferecido: é a terceira caixa, e o dono decidiu
    // que ela filtra o quadro (doc 40, item 7, 19/09).
    await expect(page.getByRole("menuitem", { name: soNaConversa, exact: true })).toBeVisible();
    await captura(page, "filtro-tela-04-quadro-oferece-o-do-contato-e-o-da-conversa");

    await page.getByRole("menuitem", { name: tagDoContato, exact: true }).click();
    await expect(page.getByRole("group", { name: `Lead: ${cardMarcado}` })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("group", { name: `Lead: ${cardNeutro}` })).toHaveCount(0);
    await captura(page, "filtro-tela-05-quadro-filtrado-pelo-contato");

    // E pelo marcador da conversa: o mesmo card, e o neutro continua fora.
    // Com um marcador escolhido, o botão do seletor passa a se chamar por ele.
    await page.getByRole("button", { name: tagDoContato, exact: true }).click();
    await page.getByRole("menuitem", { name: soNaConversa, exact: true }).click();
    await expect(page.getByRole("group", { name: `Lead: ${cardMarcado}` })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("group", { name: `Lead: ${cardNeutro}` })).toHaveCount(0);
    await captura(page, "filtro-tela-06-quadro-filtrado-pela-conversa");
  });
});
