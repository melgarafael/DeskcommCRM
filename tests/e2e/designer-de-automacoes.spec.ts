/**
 * O DESIGNER DE AUTOMAÇÕES grava a MESMA regra que o editor em lista.
 *
 * Fase 1 do designer (`app/app/webhooks/automacoes/[id]`): o canvas é outra
 * forma de montar a automação, não outra automação. A prova é pela tela, do
 * jeito que um gerente usaria, e mede três coisas:
 *
 *   1. montar no canvas → o corpo que sai para `POST /api/v1/automation-rules`
 *      tem as ações NA ORDEM DAS LIGAÇÕES (é o que substitui as setas de
 *      subir/descer do editor em lista);
 *   2. o editor em lista abre a mesma regra, com as mesmas ações na mesma ordem;
 *   3. abrir no designer e salvar sem mexer manda o MESMO corpo de volta — o
 *      desenho não muda uma automação que roda sozinha.
 *
 * E um caso de recusa: ação sem configuração não sai do canvas, e o motivo
 * aparece NA CAIXA, sem nenhuma chamada à API.
 *
 * Sem dependência externa: o gatilho é "lead ganhou tag" e as ações (tag e
 * tarefa interna) não falam com o cliente, então não há número, WAHA nem
 * janela de envio no caminho.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { test, expect, type Page, type Request } from "./helpers/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const RULE_NAME = `E2E Designer ${Date.now()}`;
const TAG = "designer-e2e";
const TITULO = "Ligar para {{contact.name}}";

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//);
}

/** Escolhe uma opção de um Select do Radix pelo rótulo acessível do gatilho. */
async function escolher(page: Page, rotulo: string, opcao: string | RegExp): Promise<void> {
  await page.getByRole("combobox", { name: rotulo }).click();
  await page.getByRole("option", { name: opcao }).click();
}

const ehRegra = (metodo: string) => (r: Request) =>
  r.url().includes("/api/v1/automation-rules") && r.method() === metodo;

/**
 * Mede o container do canvas e QUEM recebe o clique no meio da caixa do gatilho.
 *
 * `getBoundingClientRect()` é a régua do defeito da #3153: o React Flow
 * dimensiona o próprio viewport pela altura DESTE container, então 0 px aqui é
 * canvas em branco — com as caixas existindo no DOM. E `elementFromPoint` no
 * centro da caixa responde à pergunta do clique sem depender do arredondamento
 * do Playwright: ou o alvo está DENTRO da caixa, ou outra camada comeu o clique
 * (é a mesma régua de `app-no-celular.spec.ts`).
 *
 * A linha e a coluna entram na medida porque são o CONTRASTE que nomeia o
 * defeito: a linha tem centenas de px e o canvas, 0.
 */
async function medirOCanvas(page: Page, estado: string) {
  const medida = await page.getByTestId("designer-canvas").evaluate((el) => {
    const container = el as HTMLElement;
    const caixa = document.querySelector<HTMLElement>('[data-testid="caixa-gatilho"]');
    const retanguloDaCaixa = caixa === null ? null : caixa.getBoundingClientRect();
    const centro =
      retanguloDaCaixa && retanguloDaCaixa.width > 0 && retanguloDaCaixa.height > 0
        ? document.elementFromPoint(
            retanguloDaCaixa.left + retanguloDaCaixa.width / 2,
            retanguloDaCaixa.top + retanguloDaCaixa.height / 2,
          )
        : null;
    const retanguloDoPainel = document.querySelector<HTMLElement>('[data-testid="designer-painel"]')?.getBoundingClientRect();
    /**
     * Quando o clique NÃO chega à caixa, o relatório tem de nomear quem comeu o
     * clique: a leitura antiga dizia só `div[data-testid=-]` e o job ficava sem
     * como saber se era o próprio canvas, um painel ou um overlay.
     */
    const descrever = (alvo: Element): string => {
      const classe =
        typeof alvo.className === "string" && alvo.className.trim() !== ""
          ? `.${alvo.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      const estilo = getComputedStyle(alvo);
      const testid = alvo.getAttribute("data-testid");
      return `${alvo.tagName.toLowerCase()}${classe}${testid === null ? "" : `[${testid}]`}(z=${estilo.zIndex},pe=${estilo.pointerEvents})`;
    };
    const centroDaCaixa =
      retanguloDaCaixa === null
        ? null
        : { x: retanguloDaCaixa.left + retanguloDaCaixa.width / 2, y: retanguloDaCaixa.top + retanguloDaCaixa.height / 2 };
    const noDaCaixa = caixa?.closest<HTMLElement>(".react-flow__node") ?? null;
    return {
      alturaDoCanvas: Math.round(container.getBoundingClientRect().height),
      larguraDoCanvas: Math.round(container.getBoundingClientRect().width),
      alturaDaLinha: Math.round(container.parentElement?.getBoundingClientRect().height ?? -1),
      alturaDaColuna: Math.round(container.parentElement?.parentElement?.getBoundingClientRect().height ?? -1),
      alturaDaCaixa: retanguloDaCaixa ? Math.round(retanguloDaCaixa.height) : -1,
      caixasNoDom: document.querySelectorAll(".react-flow__node").length,
      cliqueChegaNaCaixa: centro !== null && caixa !== null && caixa.contains(centro),
      quemRecebeOClique:
        centro === null
          ? "ninguém (a caixa não tem área na tela)"
          : caixa !== null && caixa.contains(centro)
            ? "a caixa do gatilho"
            : `${centro.tagName.toLowerCase()}[data-testid=${centro.getAttribute("data-testid") ?? "-"}]`,
      camadasNoCentro:
        centroDaCaixa === null ? [] : document.elementsFromPoint(centroDaCaixa.x, centroDaCaixa.y).slice(0, 4).map(descrever),
      estiloDoNoDaCaixa: noDaCaixa === null ? "-" : (noDaCaixa.getAttribute("style") ?? "-"),
      painelLateralNaTela: retanguloDoPainel !== undefined && retanguloDoPainel.width > 0,
      painelLateralLargura: Math.round(retanguloDoPainel?.width ?? 0),
    };
  });
  return { estado, ...medida };
}

/**
 * Espera o canvas estar PINTADO antes de medir o clique.
 *
 * O React Flow só torna o nó um alvo de clique depois de medir a caixa; antes
 * disso o wrapper do nó está em `visibility: hidden`. Medir nessa janela mede a
 * montagem, não o produto: no CI a primeira leitura — a única que roda sem
 * nenhum clique antes — devolveu a camada do próprio canvas, um `div` sem
 * data-testid (`.react-flow__pane`), e 5 ms depois o mesmo ponto já respondia à
 * caixa (trace do job `e2e-parte (3)`).
 *
 * `toBeVisible` é a espera pelo ESTADO do produto (o nó medido pelo React
 * Flow), não um timeout: se a caixa nunca ficar visível, o defeito é do produto
 * e a falha diz isso. Os dois `requestAnimationFrame` são a barreira de pintura
 * — garantem que o quadro que desenha a caixa foi commitado antes da medida.
 */
async function esperarOCanvasPintar(page: Page): Promise<void> {
  await expect(page.getByTestId("caixa-gatilho")).toBeVisible();
  await page.evaluate(
    () => new Promise<void>((resolver) => requestAnimationFrame(() => requestAnimationFrame(() => resolver()))),
  );
}

/** O resumo de uma medida, numa linha só — é ele que aparece no log do job. */
function resumoDaMedida(m: Awaited<ReturnType<typeof medirOCanvas>>): string {
  return (
    `[${m.estado}] canvas=${m.alturaDoCanvas}x${m.larguraDoCanvas}px · linha=${m.alturaDaLinha}px · coluna=${m.alturaDaColuna}px` +
    ` · caixa do gatilho=${m.alturaDaCaixa}px · caixas no DOM=${m.caixasNoDom}` +
    ` · clique no gatilho=chega na caixa? ${m.cliqueChegaNaCaixa} (quem recebe: ${m.quemRecebeOClique})` +
    (m.cliqueChegaNaCaixa ? "" : ` · camadas no centro=${m.camadasNoCentro.join(" > ") || "-"} · estilo do nó=${m.estiloDoNoDaCaixa}`) +
    ` · painel lateral=${m.painelLateralNaTela ? "na tela" : "fora"}/${m.painelLateralLargura}px`
  );
}

test.describe("designer de automações", () => {
  test.setTimeout(120_000);
  test.use({ actionTimeout: 15_000 });

  test("monta no canvas, grava a mesma regra do editor em lista e salvar sem mexer não muda nada", async ({ page }) => {
    let ruleId: string | undefined;
    try {
      await login(page, creds.users.manager!.email);

      // ── A porta: aba Automações → "Montar no designer" ───────────────────
      await page.goto(`${APP_URL}/app/webhooks?aba=automacoes`);
      await page.getByRole("link", { name: "Montar no designer" }).first().click();
      await page.waitForURL(/\/app\/webhooks\/automacoes\/nova$/);
      await expect(page.getByTestId("caixa-gatilho")).toBeVisible();

      await page.getByRole("textbox", { name: "Nome da automação" }).fill(RULE_NAME);

      // ── QUANDO: a trava de laço vale aqui como vale no editor em lista ───
      await page.getByTestId("caixa-gatilho").click();
      // No ganho, mover o lead é a porta do pós-venda (#2769) e fica livre;
      // atribuir responsável segue travado. No perdido, os dois travam (#1528).
      await escolher(page, "O que dispara a automação", "Quando um negócio for ganho");
      await expect(page.getByTestId("paleta-create_or_move_lead")).toBeEnabled();
      await expect(page.getByTestId("paleta-assign_owner")).toBeDisabled();
      await escolher(page, "O que dispara a automação", "Quando um negócio for perdido");
      await expect(page.getByTestId("paleta-create_or_move_lead")).toBeDisabled();
      await expect(page.getByTestId("paleta-assign_owner")).toBeDisabled();
      await escolher(page, "O que dispara a automação", "Quando um lead ganhar uma tag");
      await expect(page.getByTestId("paleta-assign_owner")).toBeEnabled();

      // ── ENTÃO: duas ações pela paleta — cada clique entra no fim da fila ─
      await page.getByTestId("paleta-add_tag").click();
      await expect(page.getByTestId("caixa-acao-1")).toBeVisible();
      await page.getByPlaceholder("boas-vindas, novo-lead").fill(TAG);

      await page.getByTestId("paleta-create_task").click();
      await expect(page.getByTestId("caixa-acao-2")).toBeVisible();
      await page.getByPlaceholder("Ligar para {{contact.name}} sobre {{lead.title}}").fill(TITULO);

      // ── Salvar: o corpo é o do editor em lista, na ordem da fila ─────────
      const [criacao] = await Promise.all([
        page.waitForRequest(ehRegra("POST")),
        page.getByTestId("designer-salvar").click(),
      ]);
      const corpo = criacao.postDataJSON() as Record<string, unknown>;
      expect(corpo).toEqual({
        name: RULE_NAME,
        trigger_event: "lead.tag_added",
        conditions: [],
        actions: [
          { type: "add_tag", config: { tags: [TAG] } },
          { type: "create_task", config: { titulo: TITULO, vence_em_dias: 1, atribuir_a: "dono_do_lead", prioridade: "medium" } },
        ],
        trigger_config: {},
      });
      const resposta = await criacao.response();
      expect(resposta?.ok()).toBeTruthy();
      ruleId = ((await resposta!.json()) as { data: { id: string } }).data.id;
      await page.waitForURL(new RegExp(`/app/webhooks/automacoes/${ruleId}$`));
      await expect(page.getByText("Pausada").first()).toBeVisible();

      // ── O editor em lista abre a MESMA regra, na mesma ordem ─────────────
      await page.goto(`${APP_URL}/app/webhooks?aba=automacoes`);
      // Sobe do título até o CARD (o container com `border-border`), como em webhooks.spec.ts.
      const cartao = page
        .getByText(RULE_NAME, { exact: true })
        .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' border-border ')][1]");
      await cartao.getByRole("button", { name: "Editar automação" }).click();
      const gaveta = page.getByRole("dialog");
      await expect(gaveta.locator("#rule-name")).toHaveValue(RULE_NAME);
      const acoes = gaveta.locator("p.font-medium.text-text");
      await expect(acoes.nth(0)).toHaveText("Adicionar tag");
      await expect(acoes.nth(1)).toHaveText("Criar tarefa interna (sem mensagem ao cliente)");
      await page.keyboard.press("Escape");

      // ── Abrir no designer e salvar sem mexer: o mesmo corpo volta ────────
      await cartao.getByRole("link", { name: "Abrir no designer" }).click();
      await page.waitForURL(new RegExp(`/app/webhooks/automacoes/${ruleId}$`));
      await expect(page.getByTestId("caixa-acao-2")).toBeVisible();
      await expect(page.getByTestId("designer-alteracoes")).toHaveCount(0);
      const [semMexer] = await Promise.all([
        page.waitForRequest(ehRegra("PATCH")),
        page.getByTestId("designer-salvar").click(),
      ]);
      const { id: _id, ...devolvido } = semMexer.postDataJSON() as Record<string, unknown>;
      expect(devolvido).toEqual(corpo);

      // ── Recusa: ação sem configuração não sai do canvas ──────────────────
      await page.getByTestId("caixa-acao-2").click();
      await page.getByTestId("paleta-send_whatsapp_message").click();
      await expect(page.getByTestId("caixa-acao-3")).toBeVisible();
      let patchDepois = false;
      page.on("request", (r) => {
        if (ehRegra("PATCH")(r)) patchDepois = true;
      });
      await page.getByTestId("designer-salvar").click();
      await expect(page.getByTestId("caixa-acao-3-problema")).toContainText("Escolha o número de WhatsApp.");
      expect(patchDepois, "uma regra recusada pelo desenho não pode chegar à API").toBe(false);
    } finally {
      // Mesma sessão da tela: a rota exige gerente, e o `request` solto não tem cookie.
      if (ruleId) await page.request.delete(`${APP_URL}/api/v1/automation-rules/${ruleId}`);
    }
  });

  /**
   * O CANVAS DO DESIGNER MEDE ALTURA DE VERDADE (#3153).
   *
   * O defeito, como a #3153 o relata: o canvas aparece EM BRANCO. O
   * container do React Flow (`div.relative.h-full.flex-1`,
   * `data-testid="designer-canvas"`) mede 0 px de altura, enquanto a linha flex
   * que o contém mede centenas — e o clique na caixa do gatilho é interceptado
   * pelo container. Causa: `h-full` num item de linha flex cujo pai não tem
   * altura DEFINIDA (ela vem do `flex-1` da coluna) não resolve para a altura da
   * linha; como o filho não tem altura intrínseca, o item fica com 0 px.
   *
   * Este caso mede GEOMETRIA, não presença — `toBeVisible()` dá verde para caixa
   * dentro de container de 0 px, e foi assim que o defeito passou (a mesma lição
   * está escrita em `agenda-painel-cabe-na-tela.spec.ts`). As duas grandezas que
   * reprovam o estado antigo:
   *
   *   1. a ALTURA do container do canvas, que tem de ser maior que 0 e acompanhar
   *      a linha flex que o hospeda;
   *   2. quem recebe o CLIQUE no meio da caixa do gatilho (`elementFromPoint`),
   *      que tem de ser a própria caixa — mais o clique de verdade, que tem de
   *      abrir o formulário do gatilho no painel.
   *
   * ═══ OS TRÊS ESTADOS, e por que o terceiro existe ═══════════════════════════
   *
   * Os dois primeiros são a tela como ela é: sem nada selecionado (o painel do
   * desktop mostra o resumo) e com o gatilho selecionado (o painel abre o
   * formulário dele).
   *
   * MEDIDO nesta bancada: com a casca do produto como ela está hoje, `h-full` e
   * `self-stretch` dão a MESMA geometria (384x610 nos dois casos) — quem hospeda
   * o designer hoje entrega uma cadeia de altura definida, e o percentual do
   * `h-full` resolve. Por isso os dois primeiros estados NÃO distinguem as duas
   * classes, e um teste só com eles passaria antes e depois do conserto.
   *
   * O terceiro estado reproduz a CONDIÇÃO DA ISSUE: o hospedeiro sem altura
   * definida (é a definição do defeito — "a altura dela vem do `flex-1` da
   * coluna"), com `height: auto` na div da página. Medido aqui, no MESMO estado
   * de página:
   *
   *   classe          container do canvas   clique no gatilho
   *   `relative h-full flex-1`     384x0    NÃO chega à caixa
   *   `min-h-0 flex-1 self-stretch` 384x610  chega à caixa
   *
   * É esta a asserção com dentes: `self-stretch` (align-self) estica pela LINHA,
   * sem depender de o pai ter altura definida; `height: 100%` depende. O
   * `min-h-0` tira o piso automático do item de flex (`min-height: auto`).
   *
   * Sem organização nova e sem tocar em número de WhatsApp, WAHA ou janela de
   * envio: o gatilho é "lead ganhou tag" e nada é salvo.
   */
  test("o canvas mede altura e o clique no gatilho chega na caixa", async ({ page }) => {
    await login(page, creds.users.manager!.email);

    await page.goto(`${APP_URL}/app/webhooks?aba=automacoes`);
    await page.getByRole("link", { name: "Montar no designer" }).first().click();
    await page.waitForURL(/\/app\/webhooks\/automacoes\/nova$/);

    // `toBeAttached`, não `toBeVisible`: no estado defeituoso as caixas ESTÃO no
    // DOM (é o "aparece em branco" da issue) — esperar visibilidade esconderia o
    // defeito atrás de um timeout menos informativo.
    await expect(page.getByTestId("designer-canvas")).toBeAttached();

    // A medida do clique só vale com a caixa já medida e pintada; a espera é
    // registrada em vez de estourar para não perder as três medidas do relatório
    // se o produto regredir (aí as alturas contam a história).
    const errosDeEspera: string[] = [];
    try {
      await esperarOCanvasPintar(page);
    } catch (erro) {
      errosDeEspera.push((erro as Error).message.split("\n").slice(0, 2).join(" | "));
    }

    // O clique do usuário é a prova de tela, e ele INTERCEPTADO é o segundo
    // sintoma da issue; a falha é medida, não deixada estourar, para que as
    // alturas do estado antigo também apareçam no relatório.
    const errosDeClique: string[] = [];
    const clicarNoGatilho = async (rodada: string): Promise<void> => {
      try {
        await page.getByTestId("caixa-gatilho").click({ timeout: 5_000 });
      } catch (erro) {
        errosDeClique.push(`${rodada}: ${(erro as Error).message.split("\n").slice(0, 3).join(" | ")}`);
      }
    };

    // ── Estado 1: casca de hoje, nada selecionado ──────────────────────────
    const semSelecao = await medirOCanvas(page, "casca de hoje · sem nada selecionado");

    // ── Estado 2: casca de hoje, com o gatilho selecionado ─────────────────
    await clicarNoGatilho("casca de hoje");
    const painelDoGatilhoAberto = await page.getByRole("combobox", { name: "O que dispara a automação" }).isVisible();
    const comGatilho = await medirOCanvas(
      page,
      painelDoGatilhoAberto ? "casca de hoje · com o gatilho selecionado" : "casca de hoje · com o gatilho selecionado (o clique NÃO abriu o painel)",
    );

    // ── Estado 3: hospedeiro SEM altura definida (a condição da issue) ─────
    await page.addStyleTag({ content: "main > div { height: auto !important; }" });
    await clicarNoGatilho("hospedeiro sem altura definida");
    const semAlturaDefinida = await medirOCanvas(page, "hospedeiro sem altura definida · com o gatilho selecionado");

    for (const medida of [semSelecao, comGatilho, semAlturaDefinida]) {
      const resumo = resumoDaMedida(medida);
      console.info(`[#3153] ${resumo}`);
      expect.soft(medida.alturaDoCanvas, `o container do canvas mede 0 px de altura — canvas em branco. ${resumo}`).toBeGreaterThan(0);
      expect.soft(medida.alturaDaCaixa, `a caixa do gatilho não tem área na tela. ${resumo}`).toBeGreaterThan(0);
      expect.soft(medida.caixasNoDom, `as caixas do desenho não estão no DOM. ${resumo}`).toBeGreaterThan(0);
      expect.soft(medida.cliqueChegaNaCaixa, `o clique no meio da caixa do gatilho é interceptado. ${resumo}`).toBe(true);
      expect.soft(
        Math.abs(medida.alturaDoCanvas - medida.alturaDaLinha) <= 2,
        `o canvas tem de esticar até a altura da linha flex que o contém. ${resumo}`,
      ).toBe(true);
    }
    expect.soft(errosDeClique, `o clique do usuário na caixa do gatilho não chegou à caixa: ${errosDeClique.join(" ;; ")}`).toEqual([]);
    expect.soft(errosDeEspera, `o canvas não ficou pronto para o clique: ${errosDeEspera.join(" ;; ")}`).toEqual([]);
    expect.soft(painelDoGatilhoAberto, "o clique na caixa do gatilho tinha de abrir o formulário do gatilho no painel.").toBe(true);
  });
});
