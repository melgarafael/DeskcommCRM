/**
 * CONVERSAR COM A IA QUE ABRIU O CASO — a prova pela tela (DoD 12).
 *
 * O que um atendente faz aqui, na ordem: abre a fila de Casos, escolhe o caso,
 * lê por que a IA travou, PERGUNTA à IA sobre aquele caso e decide. Esta spec
 * dirige exatamente isso pelo navegador — nenhuma asserção de comportamento
 * visível é feita por `curl` ou por SQL.
 *
 * ═══ As quatro propriedades, e por que cada uma é uma propriedade ═══
 *
 * 1. **A conversa é da EQUIPE, e fica.** Pergunta e resposta persistem (F5) e
 *    aparecem para OUTRA pessoa da equipe com o autor identificado. Um chat que
 *    só existisse na aba de quem perguntou seria um chat particular com a IA, e
 *    a decisão do dono (item 4 do plano) foi o contrário: persistido e
 *    compartilhado no caso.
 * 2. **A fila respeita quem pode ver.** Com a organização em
 *    `visibility_mode='own'`, um `agent` que não é dono da conversa **não vê o
 *    caso** — nem na lista nem no detalhe. A fila de casos devolve título,
 *    resumo, bloqueio e nome do contato; sem este recorte ela seria a porta dos
 *    fundos da RLS de `conversations`.
 * 3. **O painel diz o MOTIVO quando não dá para perguntar.** Contato
 *    anonimizado: o campo some e entra a frase que explica. Campo que sempre
 *    falha é pior que campo ausente.
 * 4. **O painel vizinho continua alcançável.** `CaseReplyPanel` é achado por
 *    dois e2e obrigatórios com localizador frouxo (`textarea` first,
 *    `name: /^Enviar$/`). O chat mora na mesma tela — esta spec mede que ele não
 *    roubou nenhum dos dois.
 *
 * ═══ O que é dublê, e o que é real ═══
 *
 * `INTERNAL_AGENT_RUN_STUB=true` troca **só** o provedor do modelo
 * (`lib/agent-engine/agent/preview-fixture.ts`); a rota, a persona, a gravação
 * e a tela são as de produção. É como o CI roda, e é o estado de uma instalação
 * que ainda não tem chave própria de IA.
 *
 * ⚠️ **O estado "sem chave de IA" NÃO é provável por aqui.** O dublê injeta
 * `llmCfg.anthropicApiKey`, então `ia_configurada` é sempre `true` sob ele
 * (`lib/agent-engine/agent/request-deps.ts:11` + `app/api/v1/ai/cases/[id]/chat/route.ts:246`).
 * Quem guarda aquele ramo é `tests/unit/` — e esta ausência está escrita em
 * `docs/testing/user-journey-map.md`, não deduzida do silêncio.
 *
 * ⚠️ **Medida de layout é por FERRAMENTA.** `getBoundingClientRect` e
 * `getComputedStyle` dentro do navegador — nunca "parece certo no screenshot".
 * Captura `fullPage` mente sobre posição de elemento fixo (a barra lateral
 * aparece empilhada no meio do conteúdo), e foi esse artefato que motivou a
 * régua: a imagem ilustra, quem afirma é a medição.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "./helpers/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "casos-vivos", "chat");

/** Esta máquina (e o runner do CI) roda saturada; 5s viram vermelho por azar. */
const ESPERA = 60_000;

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  escalacao: {
    conversation_id: string;
    contact_id: string;
    contact_name: string;
    case_id: string;
    case_title: string;
  };
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Login com nova tentativa — e o motivo é de AMBIENTE, não de produto.
 *
 * Medido nesta bancada: sob carga, o GoTrue responde 500 "Database error
 * querying schema" e o produto traduz isso para "Email ou senha incorretos",
 * que é a frase certa para quem errou a senha e a errada para quem não errou.
 * Repetir aqui separa "o produto recusou" de "o serviço de auth engasgou": se
 * as quatro tentativas falharem, o vermelho é real.
 */
async function login(page: Page, email: string): Promise<void> {
  let ultimo = "";
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    await page.goto("/login");
    await expect(page.locator("#email")).toBeVisible({ timeout: ESPERA });
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    try {
      await page.waitForURL(/\/app(\/|$)/, { timeout: 25_000 });
      return;
    } catch (erro) {
      ultimo = erro instanceof Error ? erro.message : String(erro);
      await page.waitForTimeout(1_500 * tentativa);
    }
  }
  throw new Error(`login de ${email} falhou nas 4 tentativas — última: ${ultimo}`);
}

async function sair(page: Page): Promise<void> {
  // Pela API de sessão do próprio produto: limpar cookie no contexto é mexer no
  // estado por fora, e aqui interessa que o próximo login comece do zero.
  await page.context().clearCookies();
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/**
 * Abre a fila e seleciona o caso semeado. Devolve o painel do chat.
 *
 * ⚠️ **RECARREGA ATÉ TRÊS VEZES, e o motivo é de AMBIENTE — medido, não suposto.**
 *
 * Quando o serviço de autenticação engasga, ele devolve
 * `504 Processing this request timed out` e o produto trata a requisição como
 * NÃO AUTENTICADA (`[auth] getUser falhou — tratando como não autenticado`).
 * A consulta da fila volta vazia e a tela mostra "Nenhum caso aberto", que é
 * indistinguível de "não há casos" para quem está olhando — e para um
 * localizador também.
 *
 * Que é ambiente e não produto foi medido pelos dois lados, no mesmo minuto: as
 * MESMAS consultas (`conversasVisiveisDosCasos` + `listarChamados`), rodadas
 * com a sessão do `agent` e com a do `manager` fora do browser, devolveram
 * `visiveis: 1, chamados: 1` — enquanto a tela mostrava a fila vazia.
 *
 * Três tentativas, e não um laço: se as três falharem, o vermelho é real e a
 * mensagem diz o que procurar.
 */
async function abrirOCaso(page: Page) {
  const linha = page.getByTestId("case-item").filter({ hasText: creds.escalacao.case_title });
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    await page.goto("/app/ai/cases");
    try {
      await expect(linha).toHaveCount(1, { timeout: tentativa === 3 ? ESPERA : 20_000 });
      await linha.click();
      const chat = page.getByTestId("case-chat");
      await expect(chat).toBeVisible({ timeout: ESPERA });
      return chat;
    } catch (erro) {
      if (tentativa === 3)
        throw new Error(
          `o caso "${creds.escalacao.case_title}" não apareceu na fila em 3 aberturas. ` +
            "Se o log do servidor tiver `[auth] getUser falhou` com 504, é o serviço de " +
            `autenticação da bancada, não o produto. Original: ${
              erro instanceof Error ? erro.message : String(erro)
            }`,
        );
      await page.waitForTimeout(2_000 * tentativa);
    }
  }
  throw new Error("inalcançável");
}

/** O modo de visibilidade da organização, lido e escrito como a tela faz. */
async function definirVisibilidade(modo: "all" | "own_and_unassigned" | "own" | null) {
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", creds.org_id)
    .single();
  if (error) throw new Error(`não consegui ler settings da org: ${error.message}`);
  const settings = { ...(((data as { settings: Record<string, unknown> }).settings ?? {}) as Record<string, unknown>) };
  if (modo === null) delete settings.visibility_mode;
  else settings.visibility_mode = modo;
  const { error: erroEscrita } = await admin
    .from("organizations")
    .update({ settings })
    .eq("id", creds.org_id);
  if (erroEscrita) throw new Error(`não consegui gravar settings da org: ${erroEscrita.message}`);
}

test.describe("conversar com a IA que abriu o caso", () => {
  /**
   * O estado ANTES desta spec, restaurado no fim.
   *
   * `visibility_mode` é da ORGANIZAÇÃO e a suíte inteira compartilha uma — sair
   * daqui com `own` ligado faria `inbox-scope` e `rbac-roles` medirem um mundo
   * que este arquivo inventou. Ordem de arquivo não é contrato.
   */
  let visibilidadeOriginal: "all" | "own_and_unassigned" | "own" | null = null;

  test.beforeAll(async () => {
    /**
     * A THREAD COMEÇA VAZIA — e isso não é higiene, é o que torna dois passos
     * possíveis.
     *
     * As perguntas prontas só aparecem quando `mensagens.length === 0` (é o
     * estado "pergunte antes de decidir"), e a contagem de bolhas antes/depois
     * só significa alguma coisa partindo de zero. Sem esta limpeza a spec mede
     * a sobra da corrida anterior: o passo da sugestão reprova com o painel
     * perfeitamente correto na tela, e a contagem passa por sorte.
     *
     * Só as mensagens DESTE caso: `agent_case_chat_messages` é a conversa
     * interna da equipe, não o histórico do cliente.
     */
    const { error } = await admin
      .from("agent_case_chat_messages")
      .delete()
      .eq("organization_id", creds.org_id)
      .eq("case_id", creds.escalacao.case_id);
    if (error) throw new Error(`não consegui limpar a thread do caso: ${error.message}`);

    const { data } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", creds.org_id)
      .single();
    const bruto = (data as { settings?: Record<string, unknown> } | null)?.settings
      ?.visibility_mode;
    visibilidadeOriginal =
      bruto === "all" || bruto === "own" || bruto === "own_and_unassigned" ? bruto : null;
  });

  test.afterAll(async () => {
    await definirVisibilidade(visibilidadeOriginal);
  });

  test("a equipe pergunta, a resposta fica, e quem não pode ver não vê", async ({ page }) => {
    test.setTimeout(300_000);

    // ─── 1. o manager abre a fila e o caso ────────────────────────────────
    await login(page, creds.users.manager!.email);
    const chat = await abrirOCaso(page);
    await captura(page, "10-caso-aberto");

    // O painel existe UMA vez. `count()`, e não `toBeVisible()`: dois painéis
    // montados seria um defeito que "está visível" não pega.
    expect(await page.getByTestId("case-chat").count()).toBe(1);

    // O aviso permanente que impede o pior modo de falha de leitura — alguém
    // achar que perguntar aqui manda mensagem ao cliente.
    await expect(
      chat.getByText(/Conversa interna\. O cliente não vê nada disto/),
    ).toBeVisible();

    // O AVISO DE PERSONA. O caso do cenário nasce por `openCase` sem agente
    // ligado, então quem responde é o assistente padrão da organização — e a
    // tela DIZ isso, com o motivo entre parênteses. Sem esta faixa, quem lê a
    // resposta acha que está falando com o mesmo agente que travou, e vai
    // cobrar dele instruções que ele não tem.
    await expect(
      chat.getByText(/A IA que abriu este caso não está mais no ar/),
      "o painel tem de declarar QUEM está respondendo quando não é o agente do caso",
    ).toBeVisible();
    await expect(
      chat.getByText(/assistente padrão da organização/),
    ).toBeVisible();

    // ─── 2. a sugestão PREENCHE, nunca envia ──────────────────────────────
    const campo = chat.getByTestId("case-chat-campo");
    await expect(campo).toHaveValue("");
    const bolhasAntes = await chat.locator("time").count();
    await chat.getByRole("button", { name: "Por que a IA não resolveu sozinha?" }).click();
    await expect(campo).toHaveValue("Por que a IA não resolveu sozinha?");
    expect(
      await chat.locator("time").count(),
      "clicar na sugestão não pode gastar uma chamada paga",
    ).toBe(bolhasAntes);

    // ─── 3. a pergunta da equipe, com marca própria desta corrida ─────────
    const marca = `E2E-${Date.now()}`;
    await campo.fill(`${marca} por que a IA não resolveu sozinha?`);
    await captura(page, "20-pergunta-digitada");
    await chat.getByTestId("case-chat-enviar").click();

    // A bolha de quem perguntou, com AUTOR e HORA — as duas coisas que fazem a
    // thread ser da equipe e não um log.
    const minhaBolha = chat.locator("div").filter({ hasText: marca }).last();
    await expect(minhaBolha).toBeVisible({ timeout: ESPERA });
    await expect(chat.getByText("Pergunta da equipe").first()).toBeVisible({ timeout: ESPERA });
    await expect(chat.locator("time").first()).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}T/);

    // E a resposta da IA. O texto é o do dublê — prender a redação do modelo
    // seria um teste que reprova por humor do provedor; o que se cobra é que a
    // bolha da IA exista, tenha autor e tenha PROSA (não o JSON dos outros
    // ramos do dublê, que já apareceu na tela uma vez).
    const respostaIa = chat.getByText(/a política permite até 10%/i);
    await expect(respostaIa).toBeVisible({ timeout: ESPERA });
    await expect(chat.getByText(/^\{"/)).toHaveCount(0);
    await captura(page, "30-resposta-da-ia");

    // ─── 4. persistência: F5 e as duas bolhas continuam lá ────────────────
    await page.reload();
    const chatDepois = await abrirOCaso(page);
    await expect(chatDepois.getByText(marca)).toBeVisible({ timeout: ESPERA });
    await expect(chatDepois.getByText(/a política permite até 10%/i)).toBeVisible({
      timeout: ESPERA,
    });

    // ─── 5. MEDIDA POR FERRAMENTA, não a olho ─────────────────────────────
    const medida = await page.evaluate(() => {
      const painel = document.querySelector('[data-testid="case-chat"]') as HTMLElement | null;
      const botao = document.querySelector('[data-testid="case-chat-enviar"]') as HTMLElement | null;
      const campoEl = document.querySelector('[data-testid="case-chat-campo"]') as HTMLElement | null;
      if (!painel || !botao || !campoEl) return null;
      const r = painel.getBoundingClientRect();
      const rb = botao.getBoundingClientRect();
      const estilo = getComputedStyle(botao);
      return {
        painel: { x: Math.round(r.x), largura: Math.round(r.width) },
        botao: {
          x: Math.round(rb.x),
          largura: Math.round(rb.width),
          altura: Math.round(rb.height),
          visivel: botao.offsetParent !== null,
          fonte: estilo.fontFamily,
          fundo: estilo.backgroundColor,
        },
        campo: { largura: Math.round(campoEl.getBoundingClientRect().width) },
        rolagemHorizontal:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        janela: { largura: window.innerWidth, altura: window.innerHeight },
      };
    });
    expect(medida, "os três elementos do painel têm de estar no DOM").not.toBeNull();
    const m = medida!;
    // O botão de perguntar tem de estar ALCANÇÁVEL: `offsetParent` não nulo é o
    // que distingue "existe no DOM" de "dá para clicar".
    expect(m.botao.visivel, "o botão Perguntar não está renderizado").toBe(true);
    expect(m.botao.largura).toBeGreaterThan(40);
    expect(m.botao.altura).toBeGreaterThanOrEqual(32);
    // O painel não pode vazar da janela nem empurrar a página para o lado.
    expect(m.painel.x).toBeGreaterThanOrEqual(0);
    expect(m.painel.x + m.painel.largura).toBeLessThanOrEqual(m.janela.largura);
    expect(m.rolagemHorizontal, "página com rolagem horizontal").toBeLessThanOrEqual(0);
    // A fonte e a cor são as do PRODUTO, não as do sistema: um botão em
    // Helvetica cinza é o sintoma de tema não carregado, e ele passa
    // despercebido em screenshot.
    expect(m.botao.fonte).toMatch(/Atkinson/i);
    expect(m.botao.fundo).toMatch(/^rgba?\(/);
    expect(m.botao.fundo).not.toBe("rgba(0, 0, 0, 0)");

    // ─── 6. largura de telefone: sem rolagem lateral, com margem ──────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const noTelefone = await page.evaluate(() => ({
      rolagem: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      largura: document.documentElement.clientWidth,
    }));
    expect(
      noTelefone.rolagem,
      "em 390px a tela do caso não pode rolar para o lado",
    ).toBeLessThanOrEqual(0);
    await captura(page, "40-telefone");
    await page.setViewportSize({ width: 1440, height: 1000 });

    // ─── 7. sem jargão na tela ────────────────────────────────────────────
    const texto = (await page.getByTestId("case-chat").innerText()).toLowerCase();
    for (const proibido of ["case_chat", "purpose", "llm_call", "undefined", "null", "error_code"])
      expect(texto, `jargão "${proibido}" visível no painel`).not.toContain(proibido);

    // ─── 8. o painel de decisão continua alcançável ───────────────────────
    //
    // Os dois localizadores frouxos que `encerramento-atendimento.spec.ts` e
    // `escalacao-ciclo.spec.ts` usam. Medido com `count()`: "strict mode
    // violation" é o vermelho que aparece longe da causa.
    expect(
      await page.getByRole("button", { name: "Enviar", exact: true }).count(),
      "o chat não pode criar um segundo botão Enviar",
    ).toBe(1);
    const primeiraTextarea = page.locator("textarea").first();
    await expect(primeiraTextarea).toHaveAttribute(
      "placeholder",
      /Escreva sua resposta para a IA/i,
    );

    // ─── 9. COMPARTILHADO: outra pessoa da equipe vê a pergunta ───────────
    await sair(page);
    await login(page, creds.users.agent!.email);
    const chatDoColega = await abrirOCaso(page);
    await expect(
      chatDoColega.getByText(marca),
      "a conversa do caso é da equipe — quem chega depois tem de ver o que já foi perguntado",
    ).toBeVisible({ timeout: ESPERA });
    await expect(chatDoColega.getByText("Pergunta da equipe").first()).toBeVisible();
    await captura(page, "50-colega-ve-a-pergunta");

    // ─── 10. VISIBILIDADE: quem não pode ver a conversa não vê o caso ─────
    //
    // A conversa do cenário é de OUTRA pessoa (o manager assumiu no passo 9? —
    // não: ela continua sem dono). Em `own`, um `agent` que não é o dono não
    // enxerga nem conversa sem dono. É a RLS de `conversations` respondendo,
    // não uma cópia da regra em TypeScript.
    await definirVisibilidade("own");
    await page.goto("/app/ai/cases");
    await expect(page.getByText("Nenhum caso aberto")).toBeVisible({ timeout: ESPERA });
    expect(
      await page.getByTestId("case-item").count(),
      "com visibility_mode='own' o agente que não é dono não pode ver o caso na fila",
    ).toBe(0);
    await captura(page, "60-agente-sem-visibilidade");

    // E nem pelo link direto: a fila esconder e o detalhe entregar seria a
    // porta dos fundos.
    await page.goto(`/app/ai/cases?caso=${creds.escalacao.case_id}`);
    await expect(page.getByTestId("case-chat")).toHaveCount(0, { timeout: ESPERA });
    await expect(
      page.getByText(creds.escalacao.case_title),
      "o detalhe não pode entregar o caso que a fila escondeu",
    ).toHaveCount(0);
    await captura(page, "61-link-direto-nao-entrega");

    // O manager continua vendo (o recorte é por papel, não um apagão).
    await sair(page);
    await login(page, creds.users.manager!.email);
    await abrirOCaso(page);
    await definirVisibilidade(visibilidadeOriginal);
  });

  /**
   * CONTATO ANONIMIZADO — o painel diz o MOTIVO em vez de oferecer um campo
   * que sempre falharia.
   *
   * ═══ Por que este caso tem contato PRÓPRIO, e não o do cenário ═══
   *
   * Medido nesta bancada, e as duas razões são independentes:
   *
   * 1. **Anonimizar é irreversível por doutrina.** O produto responde 403
   *    `lgpd_anonymization_irreversible` a quem tenta voltar atrás. Uma spec que
   *    liga e desliga a marca no contato COMPARTILHADO afirma pela ação que o
   *    gesto tem volta — e deixa as vizinhas (`escalacao-ciclo`,
   *    `passagem-com-contexto`) atendendo alguém que passou por uma cascata de
   *    redação no meio do run.
   * 2. **A cascata é pesada e BLOQUEIA leitura.** `contacts` tem 11 gatilhos de
   *    `AFTER UPDATE OF is_anonymized` (propostas, captações, agenda, tarefas,
   *    rascunhos, Google, Meet…). No contato do cenário o `UPDATE` estourou o
   *    tempo do PostgREST (`An invalid response was received from the upstream
   *    server`) enquanto o Postgres seguia aplicando a cascata; as leituras
   *    seguintes ficaram penduradas na linha travada e a lista de Casos voltou
   *    VAZIA por 60 s. O vermelho dizia "o caso sumiu da fila" e a causa era o
   *    relógio da fixture. Um contato recém-criado tem cascata de tamanho zero.
   */
  test("contato anonimizado: o painel explica em vez de oferecer o campo", async ({ page }) => {
    test.setTimeout(240_000);
    const marca = Date.now();
    let contatoId = "";
    let conversaId = "";

    try {
      // ── fixture descartável: contato + conversa + caso ──────────────────
      //
      // Contato e conversa nascem pelo cliente privilegiado — é o que
      // `scripts/seed-e2e-escalacao.ts` já faz, e o objeto sob prova aqui é a
      // REAÇÃO do painel ao contato anonimizado, não como o caso nasceu.
      const { data: sessao } = await admin
        .from("channel_sessions")
        .select("id")
        .eq("organization_id", creds.org_id)
        .limit(1)
        .single();

      const contato = await admin
        .from("contacts")
        .insert({
          organization_id: creds.org_id,
          display_name: `Contato Anonimizado E2E ${marca}`,
          name: `Contato Anonimizado E2E ${marca}`,
        })
        .select("id")
        .single();
      if (contato.error) throw new Error(`contato: ${contato.error.message}`);
      contatoId = (contato.data as { id: string }).id;

      const conversa = await admin
        .from("conversations")
        .insert({
          organization_id: creds.org_id,
          contact_id: contatoId,
          channel_session_id: (sessao as { id: string }).id,
          status: "ai_handling",
          assignee_kind: "ai",
          last_inbound_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (conversa.error) throw new Error(`conversa: ${conversa.error.message}`);
      conversaId = (conversa.data as { id: string }).id;

      const caso = await admin
        .from("agent_cases")
        .insert({
          organization_id: creds.org_id,
          conversation_id: conversaId,
          status: "awaiting_human",
          title: `Caso anonimizado ${marca}`,
          summary: "Cliente pediu algo fora da política.",
          blocker: "precisa de alguém com alçada",
          source: "agent",
        })
        .select("id")
        .single();
      if (caso.error) throw new Error(`caso: ${caso.error.message}`);

      // ── a marca de anonimizado, com `anonymized_at` junto ───────────────
      //
      // `contacts_anonymized_locked` é um CHECK (`is_anonymized = false or
      // anonymized_at is not null`) e a recusa volta em `error` — que um
      // `update()` sem conferência ENGOLE. A primeira versão desta spec
      // reprovou dizendo "a frase de anonimizado não apareceu" quando o
      // contato nunca chegou a ser anonimizado: erro de fixture lido como
      // defeito do produto.
      const marcou = await admin
        .from("contacts")
        .update({ is_anonymized: true, anonymized_at: new Date().toISOString() })
        .eq("id", contatoId);
      if (marcou.error) throw new Error(`anonimizar: ${marcou.error.message}`);

      // ── pela tela ───────────────────────────────────────────────────────
      await login(page, creds.users.manager!.email);
      await page.goto("/app/ai/cases");
      const linha = page.getByTestId("case-item").filter({ hasText: `Caso anonimizado ${marca}` });
      await expect(linha).toHaveCount(1, { timeout: ESPERA });
      await linha.click();

      const chat = page.getByTestId("case-chat");
      await expect(chat).toBeVisible({ timeout: ESPERA });
      await expect(
        chat.getByText(/contato foi anonimizado a pedido dele/i),
        "sem a frase, o campo some e ninguém descobre por quê",
      ).toBeVisible({ timeout: ESPERA });
      expect(
        await chat.getByTestId("case-chat-campo").count(),
        "contato anonimizado não pode ter campo de pergunta",
      ).toBe(0);
      expect(
        await chat.getByTestId("case-chat-enviar").count(),
        "nem botão — um clique que sempre falha gasta o tempo de quem atende",
      ).toBe(0);
      // E a explicação não pode ser o enum do banco.
      const texto = (await chat.innerText()).toLowerCase();
      for (const proibido of ["is_anonymized", "lgpd_", "anonymized_at", "403"])
        expect(texto, `jargão "${proibido}" visível`).not.toContain(proibido);
      await captura(page, "70-contato-anonimizado");
    } finally {
      // A fixture some inteira — inclusive o contato anonimizado, que não tem
      // volta e não pode ficar de herança para a próxima corrida.
      if (conversaId) {
        await admin.from("agent_case_chat_messages").delete().eq("conversation_id", conversaId);
        await admin.from("agent_cases").delete().eq("conversation_id", conversaId);
        await admin.from("messages").delete().eq("conversation_id", conversaId);
        await admin.from("conversations").delete().eq("id", conversaId);
      }
      if (contatoId) await admin.from("contacts").delete().eq("id", contatoId);
    }
  });
});
