/**
 * "POR QUE A IA PASSOU PARA VOCÊ" — a passagem chega com contexto (DoD 12, P0).
 *
 * ═══ O problema que esta tela resolve ═══
 *
 * Antes, quando a IA desistia, quem assumia recebia uma conversa muda: um
 * atendimento na fila, sem saber o que o cliente queria, o que a IA já tinha
 * tentado nem se o cliente foi avisado de que alguém viria. O atendente
 * recomeçava do zero e o cliente repetia tudo — que é o momento em que ele
 * conclui que o robô não serve.
 *
 * ═══ O que esta spec prova, pela tela ═══
 *
 * 1. **O cartão está no fio da conversa**, onde o olho já está antes de o dedo
 *    digitar, e traz as quatro respostas: o motivo EM PORTUGUÊS, o que o
 *    cliente quer, o que a IA já tentou e se o cliente foi avisado.
 * 2. **Vocabulário de banco não chega à tela.** `requested_human` é uma
 *    constraint, não uma frase.
 * 3. **A fala do cliente aparece como CITAÇÃO**, separada da conclusão da IA —
 *    é a mitigação de injeção pelo histórico levada para o pixel.
 * 4. **A Central aponta para a conversa**, com o gesto "Abrir conversa", e o
 *    corpo do aviso NÃO repete o briefing (projeção curta: o aviso remete, o
 *    cartão conta).
 * 5. **Assumir muda o estado do cartão.** Depois de "Assumir e responder" o
 *    cartão deixa de convidar e passa a dizer quem assumiu — e o aviso sai dos
 *    abertos da Central sozinho, por gatilho, sem ninguém apertar nada.
 * 6. **Layout e ausência de jargão medidos por ferramenta.**
 *
 * ═══ O que é real no cenário ═══
 *
 * O cartão é montado por `montarBriefingDaPassagem` e gravado por
 * `performHumanHandoff` → `registrarPassagem` — as MESMAS funções do motor
 * (`scripts/seed-e2e-escalacao.ts`, bloco `semearPassagemComContexto`). O que o
 * seed encurta é só o gatilho: a decisão do modelo de chamar
 * `request_human_handoff`, que exigiria provedor e canal de verdade para
 * produzir exatamente a mesma declaração que o cenário escreve.
 *
 * ⚠️ **NÃO provado aqui, e está no mapa de jornadas:** o caminho em que o
 * próprio modelo decide passar (a ferramenta), e a passagem por
 * `suspected_optout` — que é a única que NÃO pode oferecer "Assumir e
 * responder". As duas são guardadas por `tests/unit/` sobre
 * `montarCartoesDaPassagem`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "casos-vivos", "passagem");
const ESPERA = 60_000;

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  passagem?: {
    conversation_id: string;
    contact_id: string;
    contact_name: string;
    motivo_frase: string;
    fala_do_cliente: string;
    tentativa: string;
  };
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Ver o comentário do helper homônimo em `conversa-do-caso.spec.ts`. */
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

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/**
 * DEVOLVE O EPISÓDIO AO ESTADO "ALGUÉM PRECISA ASSUMIR".
 *
 * O passo 6 desta spec ASSUME a conversa — de propósito, é o que se prova. O
 * efeito disso é permanente: a passagem fica reconhecida, o aviso da Central
 * fecha por gatilho e a conversa ganha dono. Sem desfazer, **a segunda execução
 * reprova na primeira asserção** ("estado esperado `aberta`, recebido
 * `reconhecida`") e o vermelho fala do produto quando o que houve foi a corrida
 * anterior. Medido: passou sozinha, reprovou ao rodar junto das vizinhas.
 *
 * Chamada no `beforeAll` **e** no `afterAll`: o `afterAll` é cortesia com quem
 * vem depois, o `beforeAll` é a garantia — ele cobre a corrida que morreu no
 * meio e não chegou a limpar nada.
 *
 * Restaura FIXTURE, não regra: nenhuma linha aqui reimplementa o que o produto
 * faz — ela só rebobina as três marcas que o gesto deixou.
 */
async function devolverEpisodioAoInicio(): Promise<void> {
  const cenario = creds.passagem;
  if (!cenario) return;
  await admin
    .from("passagens_de_atendimento")
    .update({ reconhecido_em: null, reconhecido_por: null })
    .eq("conversation_id", cenario.conversation_id);
  await admin
    .from("agent_inbox_items")
    .update({ status: "open", resolved_at: null })
    .eq("organization_id", creds.org_id)
    .eq("ref_kind", "conversation")
    .eq("ref_id", cenario.conversation_id)
    .eq("kind", "handoff");
  await admin
    .from("conversations")
    .update({ assigned_to_user_id: null, assignee_kind: "ai", status: "pending" })
    .eq("id", cenario.conversation_id);
}

test.describe("a passagem para humano chega com contexto", () => {
  test.beforeAll(async () => {
    // Precondição DECLARADA, não deduzida do vermelho: sem o bloco do seed a
    // spec falharia em `getByTestId` com uma mensagem que não diz o que fazer.
    expect(
      creds.passagem,
      "falta o bloco `passagem` em .e2e-creds.json — rode " +
        "`pnpm exec tsx --env-file=.env.e2e scripts/seed-e2e-escalacao.ts`",
    ).toBeTruthy();
    await devolverEpisodioAoInicio();
  });

  test.afterAll(devolverEpisodioAoInicio);

  test("quem assume vê o motivo, o que a IA tentou e o que o cliente disse", async ({ page }) => {
    test.setTimeout(300_000);
    const cenario = creds.passagem!;

    await login(page, creds.users.agent!.email);

    // ─── 1. o cartão, dentro do fio da conversa ───────────────────────────
    await page.goto(`/app/inbox/${cenario.conversation_id}`);
    const cartao = page.getByTestId("cartao-passagem").first();
    await expect(
      cartao,
      "sem o cartão, quem assume começa do zero e o cliente repete tudo",
    ).toBeVisible({ timeout: ESPERA });
    await expect(cartao).toHaveAttribute("data-passagem-estado", "aberta");
    await captura(page, "10-cartao-na-conversa");

    // ─── 2. as quatro respostas ───────────────────────────────────────────
    await expect(
      cartao.getByTestId("passagem-motivo"),
      "o motivo é a primeira pergunta de quem assume",
    ).toHaveText(cenario.motivo_frase);

    // `.first()` porque o rótulo da seção e o corpo do resumo (que narra "Por
    // que a IA passou…") carregam o mesmo trecho — sem ele o localizador vira
    // *strict mode violation* e o vermelho fala de sintaxe, não do produto.
    await expect(cartao.getByText("O cliente quer").first()).toBeVisible();
    await expect(
      cartao,
      "o cartão tem de dizer o que o cliente quer, na leitura da IA",
    ).toContainText("falar com uma pessoa sobre a troca do produto");

    const tentativas = cartao.getByTestId("passagem-tentativas");
    await expect(tentativas).toBeVisible();
    await expect(tentativas).toContainText(cenario.tentativa);
    expect(
      await tentativas.locator("li").count(),
      "a lista do que a IA tentou não pode nascer vazia",
    ).toBeGreaterThan(0);

    // A fala do cliente, LITERAL e entre aspas — citação, nunca conclusão.
    const citacao = cartao.locator("blockquote");
    await expect(citacao).toBeVisible();
    await expect(citacao).toContainText(cenario.fala_do_cliente);
    const textoDaCitacao = (await citacao.innerText()).trim();
    expect(
      textoDaCitacao.startsWith("“") && textoDaCitacao.endsWith("”"),
      "a palavra do cliente sai entre aspas para não se confundir com a conclusão da IA",
    ).toBe(true);

    // E se o cliente foi avisado. Neste cenário o motor não mandou aviso ao
    // lead, então a tela diz o estado que existe — a ausência da seção seria
    // "não sei" disfarçado de "está tudo bem".
    const aviso = cartao.getByTestId("passagem-aviso-ao-cliente");
    if ((await aviso.count()) > 0) {
      await expect(aviso).toContainText(/O cliente (já foi avisado|NÃO foi avisado)/);
    }

    // ─── 3. vocabulário de banco não chega à tela ─────────────────────────
    const textoDoCartao = await cartao.innerText();
    for (const codigo of [
      "requested_human",
      "suspected_optout",
      "ferramenta_do_modelo",
      "motivo_codigo",
      "undefined",
      "null",
    ])
      expect(textoDoCartao, `código de banco "${codigo}" visível no cartão`).not.toContain(codigo);

    // ─── 4. MEDIDA POR FERRAMENTA ─────────────────────────────────────────
    const medida = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="cartao-passagem"]') as HTMLElement | null;
      const b = document.querySelector('[data-testid="passagem-assumir"]') as HTMLElement | null;
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return {
        cartao: { x: Math.round(r.x), largura: Math.round(r.width), altura: Math.round(r.height) },
        botao: b
          ? {
              visivel: b.offsetParent !== null,
              altura: Math.round(b.getBoundingClientRect().height),
              // ⚠️ `offsetParent` não responde "dá para ver". O cartão mora
              // dentro do fio, que ROLA: um cartão alto empurra o convite para
              // baixo da dobra do fio, e o botão fica montado, clicável por
              // programa e invisível para quem chegou. Só o retângulo contra a
              // janela distingue os dois.
              topo: Math.round(b.getBoundingClientRect().top),
              base: Math.round(b.getBoundingClientRect().bottom),
              fonte: getComputedStyle(b).fontFamily,
              fundo: getComputedStyle(b).backgroundColor,
            }
          : null,
        rolagemHorizontal:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        janela: window.innerWidth,
        alturaDaJanela: window.innerHeight,
      };
    });
    expect(medida, "o cartão tem de estar no DOM").not.toBeNull();
    const m = medida!;
    expect(m.cartao.altura, "um cartão de 0px de altura está montado e invisível").toBeGreaterThan(
      40,
    );
    expect(m.cartao.x).toBeGreaterThanOrEqual(0);
    expect(m.cartao.x + m.cartao.largura).toBeLessThanOrEqual(m.janela);
    expect(m.rolagemHorizontal, "a conversa não pode rolar para o lado").toBeLessThanOrEqual(0);
    expect(m.botao, "a passagem aberta tem de oferecer o gesto de assumir").not.toBeNull();
    expect(m.botao!.visivel).toBe(true);
    expect(m.botao!.altura).toBeGreaterThanOrEqual(28);
    expect(m.botao!.fonte).toMatch(/Atkinson/i);
    // O convite tem de estar DENTRO da janela quando a pessoa chega. O fio rola
    // sozinho para o fim, e a passagem cala a IA — então o cartão é quase sempre
    // o último evento. Se este par sair da janela, o gesto existe e ninguém o vê.
    expect(
      m.botao!.topo,
      `"Assumir e responder" acima da janela (topo=${m.botao!.topo})`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      m.botao!.base,
      `"Assumir e responder" abaixo da dobra (base=${m.botao!.base}, janela=${m.alturaDaJanela})`,
    ).toBeLessThanOrEqual(m.alturaDaJanela);

    // Em largura de telefone o cartão continua inteiro e sem rolagem lateral.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const noTelefone = await page.evaluate(() => ({
      rolagem: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cartaoLargura: Math.round(
        (
          document.querySelector('[data-testid="cartao-passagem"]') as HTMLElement
        ).getBoundingClientRect().width,
      ),
      janela: document.documentElement.clientWidth,
    }));
    expect(noTelefone.rolagem, "em 390px a conversa não pode rolar para o lado").toBeLessThanOrEqual(
      0,
    );
    expect(noTelefone.cartaoLargura).toBeLessThanOrEqual(noTelefone.janela);
    await captura(page, "20-cartao-no-telefone");
    await page.setViewportSize({ width: 1440, height: 1000 });

    // ─── 5. a Central aponta para a conversa ──────────────────────────────
    await page.goto("/app/ai/inbox");
    // O link é localizado pelo DESTINO, nunca por posição. No CI a parte do e2e
    // divide o banco com outras specs, e a Central mostra os avisos delas também
    // — com o MESMO texto "Abrir conversa". `.first()` pegava o aviso de outra
    // spec (medido no CI: href de outra conversa, com 87 casos verdes em volta),
    // e aqui passava só porque a bancada local tinha um aviso só. Casar pelo
    // `href` é o que prova a afirmação desta etapa: a Central aponta para ESTA
    // conversa, e não para "alguma".
    const abrir = page
      .locator(`a[href*="/app/inbox/${cenario.conversation_id}"]`)
      .filter({ hasText: "Abrir conversa" });
    await expect(
      abrir,
      "a passagem tem de virar aviso na Central, apontando para ESTA conversa — senão ninguém descobre que há alguém esperando",
    ).toBeVisible({ timeout: ESPERA });
    const linhaDoAviso = page
      .locator("li, article, div")
      .filter({ hasText: "O assistente passou um atendimento para um humano" })
      .filter({ has: abrir })
      .last();
    await expect(linhaDoAviso).toBeVisible({ timeout: ESPERA });
    // O corpo do aviso REMETE, não repete: o briefing mora no cartão.
    const corpoDaCentral = await page.locator("main").innerText();
    expect(
      corpoDaCentral,
      "o aviso da Central não pode duplicar a fala do cliente — ele remete ao cartão",
    ).not.toContain(cenario.fala_do_cliente);
    await captura(page, "30-central-aponta-para-a-conversa");

    // ─── 6. assumir muda o estado, e o aviso sai dos abertos ──────────────
    await abrir.click();
    await page.waitForURL(new RegExp(`/app/inbox/${cenario.conversation_id}`), { timeout: ESPERA });
    const cartaoDeNovo = page.getByTestId("cartao-passagem").first();
    await expect(cartaoDeNovo).toBeVisible({ timeout: ESPERA });
    await cartaoDeNovo.getByTestId("passagem-assumir").click();

    await expect(
      cartaoDeNovo,
      "depois de assumir, o cartão deixa de convidar — ele vira história",
    ).toHaveAttribute("data-passagem-estado", "reconhecida", { timeout: ESPERA });
    await expect(cartaoDeNovo.getByTestId("passagem-assumir")).toHaveCount(0);
    await expect(cartaoDeNovo.getByText(/Assumida por|Alguém da equipe já assumiu/)).toBeVisible();
    await captura(page, "40-cartao-reconhecido");

    // A prova do gatilho: reconhecer a passagem fecha o aviso da Central
    // sozinho, sem ninguém apertar "resolver".
    await expect
      .poll(
        async () => {
          const { count } = await admin
            .from("agent_inbox_items")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", creds.org_id)
            .eq("ref_kind", "conversation")
            .eq("ref_id", cenario.conversation_id)
            .eq("status", "open");
          return count ?? -1;
        },
        {
          timeout: 30_000,
          message: "assumir a conversa tem de fechar o aviso — senão a Central acumula fantasma",
        },
      )
      .toBe(0);

    await page.goto("/app/ai/inbox");
    await expect(
      page.getByRole("link", { name: "Abrir conversa" }).filter({
        has: page.locator(`[href*="${cenario.conversation_id}"]`),
      }),
    ).toHaveCount(0, { timeout: ESPERA });
    await captura(page, "50-central-sem-o-aviso");
  });
});
