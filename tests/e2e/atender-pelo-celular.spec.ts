import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { strToU8, zipSync } from "fflate";
import { test, expect, type Page, type Request as PedidoDeRede, type Response as RespostaDeRede } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { provarTranscricaoOpenRouter } from "./helpers/openrouter-stt-real";

/**
 * ATENDER PELO CELULAR — F2 da ADR-0006, pela tela, como o atendente faz.
 *
 * Celular de 390x844 com toque (`isMobile` + `hasTouch`), login como `agent`,
 * uma conversa aberta e sem dono com mensagens bastantes para rolar. Toda
 * medida é por ferramenta (`getBoundingClientRect`, `getComputedStyle`,
 * `elementFromPoint`), nunca a olho: `toBeVisible()` passa em elemento coberto.
 *
 *   A-1  a conversa ocupa a tela inteira, cobre a barra de cima e a de abas,
 *        não estoura na horizontal por dentro, e o foco não fica na lista;
 *   A-2  os alvos têm 44px e "Assumir" abre a fileira, dentro da tela;
 *   A-3  voltar pela tela não reabre a conversa no voltar do navegador;
 *   A-4  voltar a partir de um link direto (o clique no aviso) não cresce o histórico;
 *   A-5  o gesto de voltar do sistema devolve a lista (guarda do que já funcionava);
 *   A-6  com o WhatsApp desconectado o documento cabe na tela e a faixa fica visível;
 *        numa tela longa, a barra de cima gruda abaixo da faixa;
 *   A-7  com o teclado aberto (modelo Android: a janela encolhe) o composer e o
 *        último balão continuam visíveis e a fileira de ações sai;
 *   A-8  a ficha do contato, aberta pelo "Ficha", tem os botões e o campo de
 *        etiqueta com 44px (antes `h-7`, 28px, por cima do primitivo).
 *
 * E o composer de toque (PR B da F2):
 *
 *   B-1  todo campo da conversa usa ≥ 16px (o iPhone não amplia a página);
 *   B-2  a tecla de retorno quebra linha e não envia; quem envia é o botão;
 *   B-3  os alvos do composer têm 44px, nada flutua por cima do Enviar, e o
 *        botão de emoji não aparece no toque;
 *   B-4  anexar uma imagem: a prévia cabe em 390 e o envio vira balão;
 *   B-5  áudio que o aparelho "não toca" (o `canPlayType` forçado a vazio): o
 *        toque busca `?formato=aac`, recebe MP4/AAC de verdade (`no-store`) e
 *        toca por `blob:`. O ogg é gerado pelo ffmpeg do próprio executor;
 *   B-6  com o teclado aberto o painel de sugestão sai da frente.
 *
 * O QUE ISTO NÃO PROVA — e só um aparelho prova: o teclado do iOS (que não
 * encolhe a janela; quem mede ali é o `visualViewport.offsetTop`), o gesto de
 * borda do app instalado, a área segura real do iPhone, a GRAVAÇÃO de áudio
 * (o Chromium sem microfone não grava; o que importa é o `MediaRecorder` do
 * Safari), e se o áudio convertido de fato SOA no iPhone com 1 toque ou 2 — o
 * B-5 prova o caminho até o `play()`, não o alto-falante. Ver a J49 em
 * `docs/testing/user-journey-map.md`.
 *
 * O dado é DESTE arquivo (conversa e contato criados no `beforeAll`, apagados
 * no `afterAll`); a conexão caída do A-6 nasce e morre dentro do próprio caso.
 */

// Trace/vídeo são opções de worker: ficam no topo, não dentro do describe.
// Este arquivo baixa URLs assinadas; preservamos as capturas/assertivas, mas
// não arquivamos a rede nem vídeos (inclusive nos casos anteriores).
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, trace: "off", video: "off" });
test.describe.configure({ timeout: 120_000 });

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
const EVIDENCE = path.join(process.cwd(), "evidence", "atender-pelo-celular-20261021");
fs.mkdirSync(EVIDENCE, { recursive: true });

const ALTURA = 844;
const LARGURA = 390;

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

test("OpenRouter STT — OGG/Opus pelo processor, Storage e workers reais, fornecedor HTTP sintético", async ({ page }, info) => {
  await provarTranscricaoOpenRouter(page, info);
});

const SUFIXO = randomUUID().slice(0, 8);
const NOME = `Cliente celular F2 ${SUFIXO}`;
let orgId = "";
let canal = "";
let contato = "";
let conversa = "";

async function insere(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

async function insereVarias(tabela: string, linhas: Record<string, unknown>[]): Promise<void> {
  const { error } = await db.from(tabela).insert(linhas);
  if (error) throw new Error(`${tabela}: ${error.message}`);
}

test.beforeAll(async () => {
  const { data, error } = await db
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", creds.users.agent!.id)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(`organização do agente: ${error?.message ?? "não achei"}`);
  orgId = (data as { organization_id: string }).organization_id;

  canal = await insere("channel_sessions", {
    organization_id: orgId,
    waha_session_name: `f2-celular-${SUFIXO}`,
    display_name: `Canal celular ${SUFIXO}`,
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  contato = await insere("contacts", {
    organization_id: orgId,
    name: NOME,
    phone_number: `+5511${randomInt(100000000, 1000000000)}`,
  });
  conversa = await insere("conversations", {
    organization_id: orgId,
    contact_id: contato,
    channel_session_id: canal,
    status: "open",
    last_message_at: new Date().toISOString(),
  });
  // 24 mensagens: mais que uma tela, para o fio ter o que rolar.
  const agora = Date.now();
  await insereVarias(
    "messages",
    Array.from({ length: 24 }, (_, i) => ({
      organization_id: orgId,
      contact_id: contato,
      conversation_id: conversa,
      channel_session_id: canal,
      direction: "inbound",
      type: "text",
      status: "received",
      body: `Mensagem ${i + 1} do cliente ${SUFIXO}, com texto bastante para ocupar uma linha inteira`,
      sent_at: new Date(agora - (24 - i) * 60_000).toISOString(),
      external_id: `f2-celular-${SUFIXO}-${i}`,
    })),
  );
});

test.afterAll(async () => {
  if (conversa) await db.from("conversations").delete().eq("id", conversa);
  if (contato) await db.from("contacts").delete().eq("id", contato);
  if (canal) await db.from("channel_sessions").delete().eq("id", canal);
});

/**
 * Login do `agent` (o `admin` para no MFA) e a sonda do toque: sem
 * `pointer: coarse` nada do que a F2 liga por toque roda, e o arquivo
 * passaria sem medir. Aqui ele reprova.
 */
async function entrar(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.agent!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
  const toque = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  expect(toque, "o navegador do teste não emula toque — nada aqui mediria o celular").toBe(true);
}

const linha = (page: Page) => page.locator(`button[data-conversation-id="${conversa}"]`);
const fio = (page: Page) => page.getByTestId("chat-thread");
const voltar = (page: Page) => page.getByRole("button", { name: "Conversas", exact: true });

/** Abre a lista "Todas", acha a conversa pela busca (16px) e toca nela. */
async function abrirPelaLista(page: Page): Promise<void> {
  await page.goto("/app/inbox?filter=all");
  await page.getByLabel("Buscar conversas").fill(SUFIXO);
  await expect(linha(page)).toBeVisible({ timeout: 60_000 });
  await linha(page).tap();
  await esperarConversa(page);
}

async function esperarConversa(page: Page): Promise<void> {
  await page.waitForURL(new RegExp(`id=${conversa}`), { timeout: 30_000 });
  await expect(page.getByTestId("message-bubble").first()).toBeVisible({ timeout: 30_000 });
}

/** A coluna da conversa: o ancestral do fio que é a camada fixa. */
async function medirCamada(page: Page) {
  return fio(page).evaluate((el) => {
    let coluna: HTMLElement | null = el as HTMLElement;
    while (coluna && getComputedStyle(coluna).position !== "fixed") coluna = coluna.parentElement;
    const r = coluna?.getBoundingClientRect();
    const dentro = (x: number, y: number) => {
      const alvo = document.elementFromPoint(x, y);
      return !!(coluna && alvo && coluna.contains(alvo));
    };
    const faixas = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--faixas-de-cima") || "0",
    );
    // A camada é `fixed`: o que estoura DENTRO dela não aumenta o
    // `body.scrollWidth`. A medida do estouro é a da própria coluna, e a borda
    // direita da fileira do composer (anexo, campo, enviar).
    const campo = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mensagem"]');
    const filhosDoComposer = Array.from(campo?.parentElement?.children ?? []);
    return {
      fixa: !!coluna,
      topo: r?.top ?? -1,
      base: r?.bottom ?? -1,
      faixas,
      cobreTopBar: dentro(195, faixas + 28),
      cobreAbas: dentro(195, window.innerHeight - 14),
      larguraDoBody: document.body.scrollWidth,
      estouroDaColuna: coluna ? coluna.scrollWidth - coluna.clientWidth : -1,
      direitaDoComposer: filhosDoComposer.length
        ? Math.max(...filhosDoComposer.map((f) => f.getBoundingClientRect().right))
        : -1,
      fonteDoCampo: campo ? parseFloat(getComputedStyle(campo).fontSize) : 0,
      alturaDoFio: el.getBoundingClientRect().height,
    };
  });
}

test.describe("atender pelo celular", () => {
  test("A-1 a conversa ocupa a tela inteira e cobre as barras", async ({ page }) => {
    await entrar(page);
    await abrirPelaLista(page);
    const fonteDaBusca = await page.evaluate(() => {
      const campo = document.querySelector<HTMLInputElement>('input[aria-label="Buscar conversas"]');
      return campo ? parseFloat(getComputedStyle(campo).fontSize) : 0;
    });
    expect(fonteDaBusca, "busca com menos de 16px amplia a página no iPhone").toBeGreaterThanOrEqual(16);

    const m = await medirCamada(page);
    expect(m.fixa, "a conversa não virou camada fixa").toBe(true);
    expect(Math.abs(m.topo - m.faixas), `topo ${m.topo} ≠ faixas ${m.faixas}`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.base - ALTURA), `base ${m.base}`).toBeLessThanOrEqual(1);
    expect(m.cobreTopBar, "a barra de cima aparece por cima da conversa").toBe(true);
    expect(m.cobreAbas, "a barra de abas aparece por cima da conversa").toBe(true);
    expect(m.larguraDoBody).toBeLessThanOrEqual(LARGURA);
    expect(m.estouroDaColuna, "algo dentro da conversa estoura na horizontal").toBeLessThanOrEqual(1);
    expect(m.direitaDoComposer, "a fileira do composer não foi achada").toBeGreaterThan(0);
    expect(m.direitaDoComposer, "o composer passa da borda direita").toBeLessThanOrEqual(LARGURA);
    expect(m.fonteDoCampo, "campo de mensagem com menos de 16px amplia a página no iPhone").toBeGreaterThanOrEqual(16);
    // No iPhone tocar num botão não tira o foco do campo; a lista escondida
    // atrás da conversa não pode seguir com a busca focada.
    const focoEscondido = await page.evaluate(() => {
      const ativo = document.activeElement;
      return !!ativo && ativo !== document.body && getComputedStyle(ativo).visibility === "hidden";
    });
    expect(focoEscondido, "o foco ficou na lista escondida atrás da conversa").toBe(false);
    // Piso, não estimativa: um terço da tela para as mensagens. O valor real
    // fica no anexo para a próxima régua.
    test.info().annotations.push({ type: "altura-do-fio", description: String(m.alturaDoFio) });
    expect(m.alturaDoFio).toBeGreaterThanOrEqual(300);
    await page.screenshot({ path: path.join(EVIDENCE, "a1-tela-cheia.png") });
  });

  test("A-2 alvos com 44px e Assumir primeiro, dentro da tela", async ({ page }) => {
    await entrar(page);
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);

    for (const nome of ["Conversas", "Ficha"]) {
      const r = await page.getByRole("button", { name: nome, exact: true }).boundingBox();
      expect(r, `"${nome}" não está na tela`).not.toBeNull();
      expect(r!.height, `"${nome}" com ${r!.height}px de altura`).toBeGreaterThanOrEqual(44);
      expect(r!.width, `"${nome}" com ${r!.width}px de largura`).toBeGreaterThanOrEqual(44);
    }

    const fileira = await page
      .getByRole("button", { name: "Transferir", exact: true })
      .evaluate((botao) => {
        const barra = botao.parentElement!;
        const filhos = Array.from(barra.children)
          .map((f) => ({ texto: (f as HTMLElement).innerText.trim(), r: f.getBoundingClientRect() }))
          .filter((f) => f.r.width > 0 && f.r.height > 0);
        return filhos.map((f) => ({ texto: f.texto, esquerda: f.r.left, direita: f.r.right, altura: f.r.height }));
      });
    const baixos = fileira.filter((f) => f.altura < 44);
    expect(baixos, "botão da fileira de ações abaixo de 44px").toEqual([]);
    const assumir = fileira.find((f) => f.texto === "Assumir");
    expect(assumir, "Assumir não está na fileira").toBeTruthy();
    expect(assumir!.esquerda).toBeGreaterThanOrEqual(0);
    expect(assumir!.direita).toBeLessThanOrEqual(LARGURA);
    const maisAEsquerda = Math.min(...fileira.map((f) => f.esquerda));
    expect(Math.abs(assumir!.esquerda - maisAEsquerda), "Assumir não é o primeiro da fileira").toBeLessThanOrEqual(1);
  });

  // A FICHA DO CONTATO, aberta pelo "Ficha" no celular. Os primitivos já têm
  // 44px abaixo de `lg` (`Button` e `Input`), mas a ficha os sobrescrevia com
  // `h-7` — 28px em qualquer largura, porque o `twMerge` troca o `h-11` da
  // variante pelo `h-7` do chamador. É a ficha lateral desenhada para mouse,
  // que no celular abre numa folha e vira alvo de dedo. O gatilho da cor da
  // etiqueta fica de fora: ele só existe para `manager+`, e este arquivo entra
  // como `agent`.
  test("A-8 a ficha do contato abre com alvos de 44px", async ({ page }) => {
    await entrar(page);
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);

    await page.getByRole("button", { name: "Ficha", exact: true }).tap();
    const ficha = page.getByRole("dialog");
    await expect(ficha.getByRole("button", { name: "Novo Lead", exact: true })).toBeVisible({ timeout: 20_000 });
    await ficha.getByRole("button", { name: "Tags do contato", exact: true }).tap();
    await expect(ficha.getByPlaceholder("Nova tag…").first()).toBeVisible();

    const alvos = [
      { nome: "Tags do contato", local: ficha.getByRole("button", { name: "Tags do contato", exact: true }), largura: false },
      { nome: "Novo Lead", local: ficha.getByRole("button", { name: "Novo Lead", exact: true }), largura: false },
      { nome: "Ver contato", local: ficha.getByRole("link", { name: "Ver contato" }), largura: false },
      { nome: "Adicionar tag", local: ficha.getByRole("button", { name: "Adicionar tag", exact: true }), largura: true },
      { nome: "Nova tag…", local: ficha.getByPlaceholder("Nova tag…"), largura: false },
    ];
    const pequenos: string[] = [];
    for (const alvo of alvos) {
      const n = await alvo.local.count();
      expect(n, `"${alvo.nome}" não está na ficha`).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        await alvo.local.nth(i).scrollIntoViewIfNeeded();
        const r = await alvo.local.nth(i).boundingBox();
        expect(r, `"${alvo.nome}" #${i} sem caixa`).not.toBeNull();
        if (r!.height < 44) pequenos.push(`${alvo.nome} #${i}: ${r!.height}px de altura`);
        if (alvo.largura && r!.width < 44) pequenos.push(`${alvo.nome} #${i}: ${r!.width}px de largura`);
      }
    }
    expect(pequenos, "alvo da ficha abaixo de 44px no celular").toEqual([]);
    await page.screenshot({ path: path.join(EVIDENCE, "a8-ficha-alvos-de-toque.png") });
  });

  test("A-3 voltar pela tela não reabre a conversa no voltar do navegador", async ({ page }) => {
    await entrar(page);
    // Uma entrada conhecida ANTES da lista: é para onde o voltar do navegador
    // tem de ir depois que a pessoa já saiu da conversa pela tela.
    await page.goto("/app/inbox?filter=mine");
    await abrirPelaLista(page);

    await voltar(page).tap();
    await expect(linha(page)).toBeVisible();
    expect(page.url()).not.toContain("id=");

    await page.goBack();
    expect(page.url(), "o voltar do navegador reabriu a conversa").not.toContain("id=");
    expect(page.url()).toContain("filter=mine");
    await expect(fio(page)).toBeHidden();
  });

  test("A-4 voltar de um link direto não cresce o histórico", async ({ page }) => {
    await entrar(page);
    // O clique no aviso abre por aqui (`/app/inbox/<id>` vira `?id=`).
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);
    const antes = await page.evaluate(() => window.history.length);

    await voltar(page).tap();
    await page.getByLabel("Buscar conversas").fill(SUFIXO);
    await expect(linha(page)).toBeVisible({ timeout: 60_000 });
    expect(page.url()).not.toContain("id=");
    expect(await page.evaluate(() => window.history.length), "voltar empilhou uma entrada").toBe(antes);
  });

  test("A-5 o gesto de voltar do sistema devolve a lista", async ({ page }) => {
    await entrar(page);
    await abrirPelaLista(page);
    await page.goBack();
    await expect(linha(page)).toBeVisible();
    expect(page.url()).not.toContain("id=");
    await expect(fio(page)).toBeHidden();
  });

  test("A-6 com o WhatsApp desconectado o documento cabe e a faixa continua visível", async ({ page }) => {
    // Nome fora da lista de sessões de seed (`lib/channels/sessoes-e2e.ts`):
    // aquelas a faixa ignora de propósito.
    const caido = await insere("channel_sessions", {
      organization_id: orgId,
      waha_session_name: `f2-caido-${SUFIXO}`,
      display_name: `Caído ${SUFIXO}`,
      status: "FAILED",
      webhook_secret_encrypted: "\\x00",
    });
    try {
      await entrar(page);
      await page.goto("/app/inbox?filter=all");
      const faixa = page.getByRole("alert").filter({ hasText: "nenhuma mensagem entra nem sai" });
      await expect(faixa).toBeVisible({ timeout: 30_000 });

      const rolagem = await page.evaluate(() => {
        window.scrollTo(0, 10_000);
        return {
          rolou: window.scrollY,
          documento: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
          janela: window.innerHeight,
        };
      });
      expect(rolagem.rolou, "a página rola: a faixa empurrou a casca para fora da tela").toBeLessThanOrEqual(1);
      expect(rolagem.documento).toBeLessThanOrEqual(rolagem.janela + 1);
      await page.screenshot({ path: path.join(EVIDENCE, "a6-lista-com-faixa.png") });

      await page.getByLabel("Buscar conversas").fill(SUFIXO);
      await expect(linha(page)).toBeVisible({ timeout: 60_000 });
      await linha(page).tap();
      await esperarConversa(page);

      const m = await faixa.evaluate((el) => {
        const involucro = el.parentElement!.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        let coluna: HTMLElement | null = document.querySelector('[data-testid="chat-thread"]');
        while (coluna && getComputedStyle(coluna).position !== "fixed") coluna = coluna.parentElement;
        const alvo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const campo = document.querySelector('textarea[aria-label="Mensagem"]')!.getBoundingClientRect();
        return {
          baseDasFaixas: involucro.bottom,
          topoDaCamada: coluna?.getBoundingClientRect().top ?? -1,
          faixaPorCima: el.contains(alvo),
          baseDoCampo: campo.bottom,
        };
      });
      expect(Math.abs(m.topoDaCamada - m.baseDasFaixas), JSON.stringify(m)).toBeLessThanOrEqual(1);
      expect(m.faixaPorCima, "a conversa cobriu o aviso de canal desconectado").toBe(true);
      expect(m.baseDoCampo, "o composer saiu pela borda de baixo").toBeLessThanOrEqual(ALTURA);
      const barraDeVoltar = await voltar(page).boundingBox();
      expect(barraDeVoltar!.y).toBeGreaterThanOrEqual(m.baseDasFaixas - 1);
      await page.screenshot({ path: path.join(EVIDENCE, "a6-conversa-com-faixa.png") });

      // Numa tela longa a página rola, e a barra de cima tem de grudar ABAIXO
      // da faixa, não por baixo dela. O espaçador simula a tela longa (Leads,
      // Configurações) sem depender de dado: o que se mede é o `sticky`.
      await voltar(page).tap();
      await expect(linha(page)).toBeVisible();
      const topo = await faixa.evaluate((el) => {
        const espaco = document.createElement("div");
        espaco.style.height = "3000px";
        document.querySelector("main")!.appendChild(espaco);
        window.scrollTo(0, 1500);
        const cabecalho = Array.from(document.querySelectorAll("header")).find(
          (h) => getComputedStyle(h).position === "sticky",
        )!;
        const barra = cabecalho.getBoundingClientRect();
        const alvo = document.elementFromPoint(barra.left + barra.width / 2, barra.top + 4);
        return {
          rolou: window.scrollY,
          baseDasFaixas: el.parentElement!.getBoundingClientRect().bottom,
          topoDaBarra: barra.top,
          barraPorCima: !!alvo && cabecalho.contains(alvo),
        };
      });
      expect(topo.rolou, "o espaçador não fez a página rolar — o caso não mediu nada").toBeGreaterThan(100);
      expect(Math.abs(topo.topoDaBarra - topo.baseDasFaixas), JSON.stringify(topo)).toBeLessThanOrEqual(1);
      expect(topo.barraPorCima, "a faixa cobre o topo da barra de cima").toBe(true);
    } finally {
      await db.from("channel_sessions").delete().eq("id", caido);
      const { data: sobrou } = await db.from("channel_sessions").select("id").eq("id", caido);
      expect(sobrou ?? [], "a conexão caída semeada vazaria para as specs seguintes").toEqual([]);
    }
  });

  test("A-7 teclado aberto: composer e último balão visíveis, ações fora", async ({ page }) => {
    await entrar(page);
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);
    await expect(page.getByRole("button", { name: "Transferir", exact: true })).toBeVisible();

    await page.getByLabel("Mensagem", { exact: true }).tap();
    try {
      // Modelo Android (`interactive-widget=resizes-content`): o teclado encolhe a janela.
      await page.setViewportSize({ width: LARGURA, height: 500 });
      await expect(page.locator("[data-teclado-aberto]")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Transferir", exact: true })).toBeHidden();

      await expect
        .poll(
          () =>
            fio(page).evaluate((el) => {
              const rolador = el.querySelector<HTMLElement>(".overflow-y-auto")!.getBoundingClientRect();
              const bolhas = el.querySelectorAll('[data-testid="message-bubble"]');
              const ultima = bolhas[bolhas.length - 1]!.getBoundingClientRect();
              const campo = document.querySelector('textarea[aria-label="Mensagem"]')!.getBoundingClientRect();
              return ultima.bottom <= rolador.bottom + 1 && ultima.top < rolador.bottom && campo.bottom <= 501;
            }),
          { message: "o último balão ou o composer ficou fora da área visível com o teclado aberto" },
        )
        .toBe(true);
      await page.screenshot({ path: path.join(EVIDENCE, "a7-teclado-aberto.png") });
    } finally {
      await page.setViewportSize({ width: LARGURA, height: ALTURA });
    }
  });

  test("B-1 todo campo da conversa usa 16px ou mais", async ({ page }) => {
    await entrar(page);
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);
    // A busca nas mensagens só existe aberta: abre antes de varrer, senão o
    // campo dela passaria sem medida.
    await page.getByRole("button", { name: "Buscar nesta conversa", exact: true }).tap();
    await expect(page.getByLabel("Buscar nas mensagens carregadas")).toBeVisible();
    // Só o que está DENTRO da camada da conversa: a lista e a barra de cima
    // ficam por baixo dela (invisíveis ou cobertas) e não são alcançáveis.
    const campos = await fio(page).evaluate((fioEl) => {
      let camada: HTMLElement | null = fioEl as HTMLElement;
      while (camada && getComputedStyle(camada).position !== "fixed") camada = camada.parentElement;
      return Array.from(
        (camada ?? document.body).querySelectorAll<HTMLElement>(
          'textarea, select, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="hidden"])',
        ),
      )
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => ({
          campo: el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.tagName,
          px: parseFloat(getComputedStyle(el).fontSize),
        }));
    });
    // A varredura enxergou os dois campos que se toca no dia a dia.
    expect(campos.map((c) => c.campo)).toEqual(
      expect.arrayContaining(["Mensagem", "Buscar nas mensagens carregadas"]),
    );
    expect(campos.filter((c) => c.px < 16), "campo com menos de 16px amplia a página no iPhone").toEqual([]);
  });

  test("B-2 a tecla de retorno quebra linha; quem envia é o botão", async ({ page }) => {
    await entrar(page);
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);
    const campo = page.getByLabel("Mensagem", { exact: true });
    const antes = await page.getByTestId("message-bubble").count();

    await campo.tap();
    await page.keyboard.type("linha 1");
    await page.keyboard.press("Enter");
    await page.keyboard.type("linha 2");
    await expect(campo).toHaveValue("linha 1\nlinha 2");
    // Uma janela curta para um envio indevido aparecer (o otimista é imediato).
    await page.waitForTimeout(1_000);
    expect(await page.getByTestId("message-bubble").count(), "o Enter enviou").toBe(antes);

    const enviar = page.getByRole("button", { name: "Enviar", exact: true });
    const r = await enviar.boundingBox();
    expect(r, "Enviar não está na tela").not.toBeNull();
    expect(r!.width).toBeGreaterThanOrEqual(44);
    expect(r!.height).toBeGreaterThanOrEqual(44);
    await enviar.tap();
    await expect(campo).toHaveValue("");
    await expect.poll(() => page.getByTestId("message-bubble").count()).toBe(antes + 1);
    await page.screenshot({ path: path.join(EVIDENCE, "b2-retorno-quebra-linha.png") });
  });

  test("B-3 alvos de 44px, nada por cima do Enviar e sem botão de emoji", async ({ page }) => {
    await entrar(page);
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);

    const medir = async (nome: string, largura: boolean) => {
      const r = await page.getByRole("button", { name: nome, exact: true }).boundingBox();
      expect(r, `"${nome}" não está na tela`).not.toBeNull();
      expect(r!.height, `"${nome}" com ${r!.height}px de altura`).toBeGreaterThanOrEqual(44);
      if (largura) expect(r!.width, `"${nome}" com ${r!.width}px de largura`).toBeGreaterThanOrEqual(44);
    };
    await medir("Anexar", true);
    await medir("Gravar áudio", true);
    await medir("Responder", false);
    await medir("Nota interna", false);
    await expect(page.getByRole("button", { name: "Emoji", exact: true })).toBeHidden();

    await page.getByLabel("Mensagem", { exact: true }).fill("oi");
    await medir("Enviar", true);
    // Cartões flutuantes (proposta em destaque, chamada) têm z-50, acima da
    // camada da conversa: o centro do Enviar tem de ser o próprio Enviar.
    const livre = await page.getByRole("button", { name: "Enviar", exact: true }).evaluate((b) => {
      const r = b.getBoundingClientRect();
      const alvo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!alvo && b.contains(alvo);
    });
    expect(livre, "algo flutua por cima do botão Enviar").toBe(true);
    await page.getByLabel("Mensagem", { exact: true }).fill("");

    // A setinha "Opções da mensagem" (a porta do Responder) desenha 20px; a
    // área de acerto no toque é de 44. A medida é `elementFromPoint` a 20px do
    // centro nas quatro direções: a caixa do botão não enxerga o `::before`.
    const opcoes = page.getByTestId("message-bubble").first().getByRole("button", { name: "Opções da mensagem" });
    await opcoes.evaluate((b) => b.scrollIntoView({ block: "center" }));
    const acerto = await opcoes.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return [[20, 0], [-20, 0], [0, 20], [0, -20]].map(([dx, dy]) => {
        const alvo = document.elementFromPoint(cx + dx!, cy + dy!);
        return { dx, dy, acerta: !!alvo && b.contains(alvo) };
      });
    });
    expect(acerto.filter((p) => !p.acerta), "a setinha das opções tem menos de 44px de área de toque").toEqual([]);

    // O ✕ da citação: responder a uma mensagem pelo menu da bolha.
    await opcoes.tap();
    await page.getByRole("menuitem", { name: /Responder a esta mensagem/i }).tap();
    await medir("Cancelar resposta", true);
  });

  test("B-4 anexar uma imagem: a prévia cabe em 390 e o envio vira balão", async ({ page }) => {
    await entrar(page);
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);
    const antes = await page.getByTestId("message-bubble").count();

    // PNG de 1x1: o menor arquivo que o upload aceita como imagem.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page
      .locator('input[type="file"][accept^="image/"]')
      .setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: png });
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible();
    const r = await dialogo.boundingBox();
    expect(r!.x, "a prévia sai pela esquerda").toBeGreaterThanOrEqual(0);
    expect(r!.x + r!.width, "a prévia sai pela direita").toBeLessThanOrEqual(LARGURA);
    await page.screenshot({ path: path.join(EVIDENCE, "b4-previa-do-anexo.png") });

    await dialogo.getByRole("button", { name: "Enviar", exact: true }).tap();
    await expect(dialogo).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => page.getByTestId("message-bubble").count()).toBe(antes + 1);
    await expect(page.getByTestId("message-bubble").last().locator("img")).toHaveCount(1);
  });

  test("B-5 áudio que o aparelho não toca vira AAC e toca por blob:", async ({ page }) => {
    // O ogg/opus é gerado AQUI pelo ffmpeg do executor (o passo do e2e.yml
    // instala e reprova se faltar encoder): é o formato de toda nota de voz.
    // 20s, e não 2: o desfecho "tocando" é lido depois do play(), e um áudio
    // curto já teria acabado e voltado a "Reproduzir".
    const ogg = execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
      "-c:a", "libopus", "-f", "ogg", "pipe:1",
    ]);
    const caminho = `${orgId}/${conversa}/in-f2-${SUFIXO}.ogg`;
    const { error: erroDoUpload } = await db.storage
      .from("whatsapp-media")
      .upload(caminho, ogg, { contentType: "audio/ogg; codecs=opus", upsert: true });
    if (erroDoUpload) throw new Error(`storage: ${erroDoUpload.message}`);
    const audio = await insere("messages", {
      organization_id: orgId,
      contact_id: contato,
      conversation_id: conversa,
      channel_session_id: canal,
      direction: "inbound",
      type: "audio",
      status: "received",
      media_mime: "audio/ogg; codecs=opus",
      media_storage_path: caminho,
      media_size_bytes: ogg.length,
      sent_at: new Date().toISOString(),
      external_id: `f2-celular-${SUFIXO}-audio`,
    });
    try {
      // O Safari antigo do iPhone diz "" para ogg; o Chromium do teste toca.
      // Forçar a resposta é o único jeito de dirigir o caminho do iPhone aqui —
      // e o `play()` é anotado para provar que foi chamado com o blob.
      await page.addInitScript(() => {
        const original = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function (tipo: string) {
          return /ogg|opus|webm/i.test(tipo) ? "" : original.call(this, tipo);
        };
        const tocar = HTMLMediaElement.prototype.play;
        (window as unknown as { __plays: string[] }).__plays = [];
        HTMLMediaElement.prototype.play = function () {
          (window as unknown as { __plays: string[] }).__plays.push(this.src);
          return tocar.call(this);
        };
      });
      await entrar(page);
      await page.goto(`/app/inbox?filter=all&id=${conversa}`);
      await esperarConversa(page);

      const resposta = page.waitForResponse((r) => r.url().includes(`/messages/${audio}/media?formato=aac`));
      await page.getByRole("button", { name: "Reproduzir áudio" }).tap();
      const r = await resposta;
      expect(r.status()).toBe(200);
      expect(r.headers()["content-type"]).toBe("audio/mp4");
      expect(r.headers()["cache-control"]).toContain("no-store");
      // O corpo é lido por um pedido PRÓPRIO, na mesma sessão: o Chromium não
      // guarda para o Playwright o corpo que a página consome como `blob()`, e
      // `r.body()` voltava vazio com o player tocando os 20s (medido na prova).
      const corpo = await (await page.request.get(r.url())).body();
      // Caixa `ftyp` nos bytes 4..8: é MP4 de verdade, não o ogg devolvido.
      expect(corpo.subarray(4, 8).toString("latin1"), "a resposta não é MP4").toBe("ftyp");
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __plays: string[] }).__plays))
        .toContainEqual(expect.stringMatching(/^blob:/));

      // O `__plays` anota o `src` ANTES do `play()` original: sozinho, ele
      // passaria mesmo com o player caindo em "indisponível" porque o Chromium
      // do executor não decodifica AAC. O relatório diz qual dos dois houve, e
      // quando o executor declara AAC o player TEM de estar tocando.
      const aac = await page.evaluate(() =>
        document.createElement("audio").canPlayType('audio/mp4; codecs="mp4a.40.2"'),
      );
      const pausar = page.getByRole("button", { name: "Pausar áudio" });
      const indisponivel = page.getByText("Mídia indisponível", { exact: false });
      await expect(pausar.or(indisponivel).first()).toBeVisible({ timeout: 15_000 });
      const desfecho = (await pausar.count()) > 0 ? "tocando" : "indisponível";
      test.info().annotations.push({
        type: "B-5 desfecho",
        description: `canPlayType(AAC) do executor = "${aac}"; player ${desfecho}`,
      });
      if (aac !== "") expect(desfecho, "o executor toca AAC e o player não tocou").toBe("tocando");
    } finally {
      await db.from("messages").delete().eq("id", audio);
      await db.storage.from("whatsapp-media").remove([caminho]);
    }
  });

  test("B-6 teclado aberto: o painel de sugestão sai da frente", async ({ page }) => {
    // O painel só é montado quando HÁ sugestão (issue #3027). O que este caso
    // mede é a camada (teclado aberto esconde o painel), não a origem do
    // rascunho: a leitura da sugestão devolve uma pendente, sem gerar nada.
    await page.route(`**/api/v1/conversations/${conversa}/draft-reply`, async (rota) => {
      if (rota.request().method() !== "GET") return rota.fallback();
      await rota.fulfill({
        json: {
          data: {
            drafts: [
              {
                id: "00000000-0000-4000-8000-0000000000b6",
                revision: "1",
                status: "pending",
                original_body: `Sugestão de resposta ${SUFIXO}`,
                edited_body: null,
                error_code: null,
                proposals: [],
              },
            ],
          },
        },
      });
    });
    await entrar(page);
    await page.goto(`/app/inbox?filter=all&id=${conversa}`);
    await esperarConversa(page);
    const painel = page.getByLabel("Assistência do agente");
    await expect(painel, "o painel de sugestão não aparece com o teclado fechado").toBeVisible();

    await page.getByLabel("Mensagem", { exact: true }).tap();
    try {
      await page.setViewportSize({ width: LARGURA, height: 500 });
      await expect(page.locator("[data-teclado-aberto]")).toHaveCount(1);
      await expect(painel).toBeHidden();
      await page.screenshot({ path: path.join(EVIDENCE, "b6-teclado-sem-painel.png") });
    } finally {
      await page.setViewportSize({ width: LARGURA, height: ALTURA });
    }
  });
});


// Mesma bancada real de mídia do B-5, sem dublar rota, Storage ou download.
test.describe("documentos recebidos: rótulo e arquivo salvo (#2613)", () => {
  test("XLSX/PDF preservam nome com acento e bytes; MIME-only tem rótulo legível", async ({ page }) => {
    const partes = {
      "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Controle" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Controle sintético</t></is></c></row></sheetData></worksheet>',
    };
    const xlsx = Buffer.from(zipSync(Object.fromEntries(Object.entries(partes).map(([k, v]) => [k, strToU8(v)]))));
    const arquivos = [
      { nome: "Relatório sintético.xlsx", ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: xlsx },
      { nome: "Orçamento sintético.pdf", ext: "pdf", mime: "application/pdf", bytes: fs.readFileSync(path.join(process.cwd(), "tests/fixtures/sample-text.pdf")) },
    ];
    const mensagens: string[] = [];
    const caminhos: string[] = [];
    try {
      for (const arquivo of arquivos) {
        const id = randomUUID();
        const caminho = `${orgId}/${conversa}/${id}.${arquivo.ext}`;
        caminhos.push(caminho);
        const upload = await db.storage.from("whatsapp-media").upload(caminho, arquivo.bytes, { contentType: arquivo.mime });
        expect(upload.error).toBeNull();
        mensagens.push(await insere("messages", {
          id, organization_id: orgId, conversation_id: conversa, contact_id: contato, channel_session_id: canal,
          type: "document", direction: "inbound", status: "received", sent_at: new Date().toISOString(),
          media_mime: arquivo.mime, media_storage_path: caminho, media_size_bytes: arquivo.bytes.length,
          metadata: { media_filename: arquivo.nome }, external_id: `documento-${id}`,
        }));
      }
      // Objeto real com extensão genérica: a bolha tem mídia, mas só o MIME
      // pode dizer XLSX. Não usamos o corpo para fabricar o rótulo esperado.
      const semNome = randomUUID();
      const caminhoSemNome = `${orgId}/${conversa}/${semNome}.bin`;
      caminhos.push(caminhoSemNome);
      const uploadSemNome = await db.storage.from("whatsapp-media").upload(caminhoSemNome, xlsx, { contentType: arquivos[0]!.mime });
      expect(uploadSemNome.error).toBeNull();
      mensagens.push(await insere("messages", {
        id: semNome,
        organization_id: orgId, conversation_id: conversa, contact_id: contato, channel_session_id: canal,
        type: "document", direction: "inbound", status: "received", sent_at: new Date().toISOString(),
        media_mime: arquivos[0]!.mime, media_storage_path: caminhoSemNome, media_size_bytes: xlsx.length,
        metadata: {}, external_id: `mime-only-${SUFIXO}`,
      }));
      await entrar(page);
      await page.goto(`/app/inbox?filter=all&id=${conversa}`);
      await esperarConversa(page);
      const rotuloMime = page.getByText("Documento XLSX", { exact: true });
      await expect(rotuloMime).toBeVisible();
      const medirRotuloMime = () => rotuloMime.evaluate((rotulo) => ({
        larguraVisivel: rotulo.clientWidth,
        larguraDoTexto: rotulo.scrollWidth,
        semTruncamento: rotulo.scrollWidth <= rotulo.clientWidth,
      }));
      await expect.poll(async () => (await medirRotuloMime()).semTruncamento, {
        message: "o rótulo Documento XLSX precisa mostrar o formato inteiro no celular",
      }).toBe(true);
      const rotuloMimeMedido = await medirRotuloMime();
      for (const [i, arquivo] of arquivos.entries()) {
        await expect(page.getByText(arquivo.nome, { exact: true })).toBeVisible();
        await expect(page.getByText(arquivo.nome, { exact: true })).toHaveAttribute("title", arquivo.nome);
        const baixar = page.getByRole("link", { name: new RegExp(`^Baixar ${arquivo.nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
        await expect(baixar).toHaveAttribute("href", `/api/v1/messages/${mensagens[i]}/media?baixar=1`);
        // Controle do preview pela rota real: não pede o Content-Disposition de download.
        const preview = await page.request.get(`/api/v1/messages/${mensagens[i]}/media`, { maxRedirects: 0 });
        expect(preview.status()).toBe(302);
        expect(new URL(preview.headers()["location"]!).searchParams.has("download")).toBe(false);
        const contexto = page.context();
        const medirAlvo = () => baixar.evaluate((link) => {
          const r = link.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const alvo = document.elementFromPoint(x, y);
          const esquerda = Math.max(0, r.left);
          const direita = Math.min(window.innerWidth, r.right);
          const topo = Math.max(0, r.top);
          const fundo = Math.min(window.innerHeight, r.bottom);
          const temRecorte = direita > esquerda && fundo > topo;
          const recorteX = temRecorte ? (esquerda + direita) / 2 : null;
          const recorteY = temRecorte ? (topo + fundo) / 2 : null;
          const alvoDoRecorte = recorteX !== null && recorteY !== null
            ? document.elementFromPoint(recorteX, recorteY) : null;
          const bolha = link.closest('[data-testid="message-bubble"]');
          const menu = bolha?.querySelector('button[aria-label="Opções da mensagem"]');
          const caixaDaBolha = bolha?.getBoundingClientRect();
          const cartao = link.parentElement?.getBoundingClientRect();
          const acerto = (elemento: Element | null | undefined) => {
            if (!elemento) return [];
            const caixa = elemento.getBoundingClientRect();
            const cx = caixa.left + caixa.width / 2;
            const cy = caixa.top + caixa.height / 2;
            return [[20, 0], [-20, 0], [0, 20], [0, -20]].map(([dx, dy]) => {
              const ponto = document.elementFromPoint(cx + dx!, cy + dy!);
              return !!ponto && elemento.contains(ponto);
            });
          };
          return {
            x, y, largura: r.width, altura: r.height,
            viewportLargura: window.innerWidth, viewportAltura: window.innerHeight,
            visualLargura: window.visualViewport?.width ?? window.innerWidth,
            visualAltura: window.visualViewport?.height ?? window.innerHeight,
            centroNaViewport: x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight,
            linkNoCentro: !!alvo && link.contains(alvo),
            opcoesNoCentro: !!alvo?.closest('button[aria-label="Opções da mensagem"]'),
            tagNoCentro: alvo?.tagName ?? null,
            recorteX, recorteY,
            linkNoCentroDoRecorte: !!alvoDoRecorte && link.contains(alvoDoRecorte),
            opcoesNoCentroDoRecorte: !!alvoDoRecorte?.closest('button[aria-label="Opções da mensagem"]'),
            tagNoCentroDoRecorte: alvoDoRecorte?.tagName ?? null,
            acertoDoDownload: acerto(link),
            acertoDoMenu: acerto(menu),
            cartaoDentroDaBolha: !!cartao && !!caixaDaBolha
              && cartao.left >= caixaDaBolha.left && cartao.right <= caixaDaBolha.right,
            paginaSemOverflowHorizontal: document.documentElement.scrollWidth <= window.innerWidth,
          };
        });
        type MedidaDoAlvo = Awaited<ReturnType<typeof medirAlvo>>;
        const observado = {
          rotuloMime: rotuloMimeMedido,
          ponto: null as MedidaDoAlvo | null,
          pontoDepois: null as MedidaDoAlvo | null,
          paginasNovasNoContexto: 0,
          toqueConcluiu: null as boolean | null,
          eventoRecebido: null as boolean | null,
          downloadNaPaginaOriginal: null as boolean | null,
          respostas: [] as Array<{ tipo: "rota" | "storage"; status: number; attachment: boolean; parametroDownload: boolean; nomeNoParametro: boolean }>,
          falhasDeRede: [] as Array<"rota" | "storage">,
        };
        // Só classificamos o fluxo deste objeto; nenhuma URL/token vai ao diagnóstico.
        const tipoDaUrl = (valor: string): "rota" | "storage" | null => {
          try {
            const u = new URL(valor);
            if (u.pathname === `/api/v1/messages/${mensagens[i]}/media` && u.searchParams.get("baixar") === "1") return "rota";
            if (u.pathname.endsWith(`/whatsapp-media/${caminhos[i]}`)) return "storage";
          } catch { /* URL inválida não deve acabar no relatório de erro. */ }
          return null;
        };
        const respostaDoGesto = (r: RespostaDeRede) => {
          const tipo = tipoDaUrl(r.url());
          if (!tipo) return;
          const headers = r.headers();
          let destino: URL | null = null;
          try { destino = new URL(headers.location ?? r.url(), r.url()); } catch { /* Só registramos flags. */ }
          observado.respostas.push({
            tipo, status: r.status(),
            attachment: /^attachment(?:;|$)/i.test(headers["content-disposition"] ?? ""),
            parametroDownload: destino?.searchParams.has("download") ?? false,
            nomeNoParametro: destino?.searchParams.get("download") === arquivo.nome,
          });
        };
        const falhaDoGesto = (r: PedidoDeRede) => {
          const tipo = tipoDaUrl(r.url());
          if (tipo) observado.falhasDeRede.push(tipo);
        };
        const novaPagina = () => { observado.paginasNovasNoContexto += 1; };
        contexto.on("response", respostaDoGesto);
        contexto.on("requestfailed", falhaDoGesto);
        contexto.on("page", novaPagina);
        try {
          await baixar.scrollIntoViewIfNeeded();
          // Observação, sem impedir o tap de rolar e escolher um ponto visível.
          // O download real abaixo continua sendo a condição de sucesso.
          observado.ponto = await medirAlvo();
          // Espera ambas as operações e prioriza o erro do gesto, para o
          // timeout do evento não esconder um toque interceptado.
          const [evento, toque] = await Promise.allSettled([
            contexto.waitForEvent("download", { predicate: (d) => tipoDaUrl(d.url()) !== null, timeout: 30_000 }),
            baixar.tap({ timeout: 30_000 }),
          ]);
          observado.toqueConcluiu = toque.status === "fulfilled";
          observado.eventoRecebido = evento.status === "fulfilled";
          if (toque.status === "rejected") throw toque.reason;
          if (evento.status === "rejected") throw evento.reason;
          const download = evento.value;
          observado.downloadNaPaginaOriginal = download.page() === page;
          expect(download.suggestedFilename()).toBe(arquivo.nome);
          expect((await download.failure()) === null).toBe(true);
          const salvo = await download.path();
          expect(Boolean(salvo)).toBe(true);
          // Booleano evita despejar bytes ou URL assinada em caso de falha.
          expect(fs.readFileSync(salvo!).equals(arquivo.bytes)).toBe(true);
          // Os dois alvos mantêm ao menos 44px úteis; o nome/bytes acima só
          // passam depois do tap nativo, nunca por um ponto forçado.
          expect(observado.ponto?.largura).toBeGreaterThanOrEqual(44);
          expect(observado.ponto?.altura).toBeGreaterThanOrEqual(44);
          expect(observado.ponto?.acertoDoDownload).toEqual([true, true, true, true]);
          expect(observado.ponto?.acertoDoMenu).toEqual([true, true, true, true]);
          expect(observado.ponto?.centroNaViewport).toBe(true);
          expect(observado.ponto?.cartaoDentroDaBolha).toBe(true);
          expect(observado.ponto?.paginaSemOverflowHorizontal).toBe(true);
        } finally {
          try { observado.pontoDepois = await medirAlvo(); } catch { /* Página pode ter fechado; sem registrar erro cru. */ }
          contexto.off("response", respostaDoGesto);
          contexto.off("requestfailed", falhaDoGesto);
          contexto.off("page", novaPagina);
          const nomeDoRecibo = `documento-download-${i + 1}-observado.json`;
          const recibo = JSON.stringify(observado, null, 2);
          const saida = test.info().outputPath(nomeDoRecibo);
          fs.mkdirSync(path.dirname(saida), { recursive: true });
          fs.writeFileSync(saida, recibo);
          // O reporter=list não persiste attachment.body. Arquivo físico na
          // falha e no coletor de sucesso, sempre só flags/medidas sanitizadas.
          const evidencia = path.join("evidence", "documento-3511-01a178b3");
          fs.mkdirSync(evidencia, { recursive: true });
          await page.screenshot({ path: path.join(evidencia, `documento-download-${i + 1}-antes-limpeza.png`) });
          fs.writeFileSync(path.join(evidencia, nomeDoRecibo), recibo);
          await test.info().attach(`documento-download-${i + 1}-observado`, { path: saida, contentType: "application/json" });
        }
      }
      fs.mkdirSync("evidence/documento-3511-01a178b3", { recursive: true });
      await page.screenshot({ path: "evidence/documento-3511-01a178b3/documentos-no-inbox.png" });
    } finally {
      // Uma falha de limpeza não pode impedir a tentativa da outra.
      const limpezas = await Promise.allSettled([
        mensagens.length ? db.from("messages").delete().eq("organization_id", orgId).in("id", mensagens) : Promise.resolve({ error: null }),
        caminhos.length ? db.storage.from("whatsapp-media").remove(caminhos) : Promise.resolve({ error: null }),
      ]);
      expect(limpezas.every((r) => r.status === "fulfilled" && r.value.error === null), "a prova precisa limpar seus recursos sintéticos").toBe(true);
    }
  });
});
