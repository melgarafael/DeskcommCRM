import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "./helpers/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

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
 *        último balão continuam visíveis e a fileira de ações sai.
 *
 * O QUE ISTO NÃO PROVA — e só um aparelho prova: o teclado do iOS (que não
 * encolhe a janela; quem mede ali é o `visualViewport.offsetTop`), o gesto de
 * borda do app instalado, e a área segura real do iPhone. Ver a J49 em
 * `docs/testing/user-journey-map.md`.
 *
 * O dado é DESTE arquivo (conversa e contato criados no `beforeAll`, apagados
 * no `afterAll`); a conexão caída do A-6 nasce e morre dentro do próprio caso.
 */

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
});
