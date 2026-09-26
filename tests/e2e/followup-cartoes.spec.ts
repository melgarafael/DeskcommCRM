/**
 * A PROVA EM TELA do print de 16/09/2026, em que o dono do produto mostrava o
 * construtor de fluxos e o cartão do nó dizia coisas que o motor não faz:
 *
 *   - "O lead está na etapa “PAGO”" — o motor compara o `stage_id`, então essa
 *     regra NUNCA era verdadeira. O campo era de texto livre;
 *   - "O fluxo já deu pelo menos 0 pas…" — a regra com que todo nó nascia é
 *     verdadeira para todo lead, e o texto ainda saía cortado no meio;
 *   - "2 classes · grace 15min" — o nome do campo do banco na tela;
 *   - "Sempre" ao lado de saídas específicas, prometendo o que não acontece.
 *
 * O que este arquivo prova, clicando:
 *   1. a etapa é ESCOLHIDA numa lista e aparece pelo nome, nunca o identificador;
 *   2. nenhum texto do cartão é cortado (medido por scrollWidth/scrollHeight,
 *      nunca a olho);
 *   3. regra sem valor não publica, e o aviso diz QUAL regra;
 *   4. a consequência: um lead na etapa escolhida sai pela saída daquela regra,
 *      e um lead em outra etapa sai por "Nenhuma delas" — que era exatamente o
 *      que a versão do print não conseguia fazer.
 *
 * Os utilitários abaixo espelham `followup-ramos.spec.ts` de propósito: as duas
 * dirigem o mesmo canvas, e uma cópia local é mais barata que um módulo
 * compartilhado que ninguém mantém.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./helpers/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = ".e2e-creds.json";
const ARTIFACTS_DIR = "evidence/followup-cartoes";
/** A máquina roda saturada por outras sessões (login medido em 15s). */
const PRAZO = 60_000;
const UUID_RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app\//, { timeout: PRAZO });
}

async function novoFluxo(page: Page, nome: string): Promise<string> {
  await page.goto("/app/ai/followups");
  await page.getByRole("button", { name: "Novo fluxo" }).click();
  const dialogo = page.getByRole("dialog");
  const campoNome = dialogo.getByLabel("Nome");
  await expect(campoNome).toBeFocused({ timeout: PRAZO });
  await campoNome.fill(nome);
  await dialogo.getByRole("button", { name: "Criar fluxo" }).click();
  await expect(dialogo).not.toBeVisible({ timeout: PRAZO });
  await page.locator("li", { hasText: nome }).getByRole("link").click();
  await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/, { timeout: PRAZO });
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO });
  return page.url().split("/").pop()!;
}

async function idPorPrefixo(page: Page, prefixo: string): Promise<string[]> {
  const els = await page.locator(`.react-flow__node[data-id^="${prefixo}-"]`).all();
  const ids: string[] = [];
  for (const el of els) {
    const id = await el.getAttribute("data-id");
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Arrastar um nó até (x, y) — e CONFERIR que ele chegou.
 *
 * Duas coisas que o arrasto solto não garante, as duas medidas no CI:
 *   - o `mouseDown` num ponto fora da janela não pega nada, e o nó fica onde
 *     estava (era o que acontecia quando o canvas ampliava sozinho: o 4º nó
 *     nascia em x=1668 numa janela de 1600);
 *   - sob carga, o último movimento do arrasto às vezes não chega a ser
 *     aplicado antes do `mouseUp`, e o nó para no meio do caminho (medido:
 *     alvo (1288, 679), parou em (1210, 405)).
 * Nos dois casos o teste seguia e quebrava passos depois, em asserções que não
 * têm nada a ver. Aqui ele insiste, e só falha se o nó não chegar.
 */
async function moverNo(page: Page, nodeId: string, x: number, y: number): Promise<void> {
  const card = page.locator(`[data-testid="node-card-${nodeId}"]`);
  const perto = (b: { x: number; y: number; width: number } | null): boolean =>
    !!b && Math.abs(b.x + b.width / 2 - x) < 20 && Math.abs(b.y + 12 - y) < 20;
  let box = await card.boundingBox();
  if (!box) throw new Error(`nó sem bounding box: ${nodeId}`);
  for (let tentativa = 0; tentativa < 3 && !perto(box); tentativa++) {
    // Relido a cada volta, então o TypeScript não carrega a garantia da linha
    // acima para dentro do laço — e a guarda vale mesmo: um nó apagado do DOM
    // entre duas tentativas não tem caixa.
    if (!box) throw new Error(`nó sem bounding box: ${nodeId}`);
    const viewport = page.viewportSize();
    const pega = { x: box.x + box.width / 2, y: box.y + 12 };
    if (viewport && (pega.x > viewport.width || pega.y > viewport.height || pega.x < 0 || pega.y < 0)) {
      throw new Error(`o nó ${nodeId} está fora da janela (${JSON.stringify(pega)}): o arrasto não teria o que pegar`);
    }
    await page.mouse.move(pega.x, pega.y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 10 });
    // O mesmo ponto de novo antes de soltar: é o que garante que a última
    // posição foi aplicada, e não engolida junto com o `mouseUp`.
    await page.mouse.move(x, y);
    await page.mouse.up();
    await page.waitForTimeout(150);
    box = await card.boundingBox();
  }
  expect(perto(box), `o nó ${nodeId} não chegou a (${x}, ${y}): está em ${JSON.stringify(box)}`).toBe(true);
}

async function ligar(page: Page, origem: string, destino: string, ramo?: string): Promise<void> {
  const seletor = ramo
    ? `.react-flow__node[data-id="${origem}"] .react-flow__handle.source[data-handleid="${ramo}"]`
    : `.react-flow__node[data-id="${origem}"] .react-flow__handle.source`;
  const source = page.locator(seletor).first();
  const target = page.locator(`.react-flow__node[data-id="${destino}"] .react-flow__handle.target`);
  const sBox = await source.boundingBox();
  const tBox = await target.boundingBox();
  if (!sBox || !tBox) throw new Error(`handle não encontrado: ${origem}[${ramo}] -> ${destino}`);
  await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sBox.x + sBox.width / 2 + 5, sBox.y + sBox.height / 2 + 5, { steps: 3 });
  await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/**
 * Publicar e EXIGIR sucesso — dizendo o motivo quando o publish recusa.
 *
 * `expect(getByText("Fluxo publicado.")).toBeVisible()` sozinho gasta o PRAZO
 * inteiro e reporta "o toast não apareceu", que é o sintoma e não a causa: o
 * publish pode ter recusado o fluxo e ancorado o motivo num nó. O conserto do
 * salto de zoom (`12d79edf0`) provou o custo disso no caso do posicionamento —
 * a falha nascia no arrasto e só aparecia três passos depois, no toast ausente.
 * `moverNo` fechou aquele caminho; este fecha o resto, que são as recusas de
 * validação (ramo sem cobertura, regra em branco) e não têm nada a ver com
 * coordenada.
 */
async function publicarEExigirSucesso(page: Page): Promise<void> {
  await page.getByTestId("publish-button").click();
  const toast = page.getByText("Fluxo publicado.");
  const recusa = page.locator('[data-testid^="node-error-"]').first();
  await expect
    .poll(
      async () =>
        (await toast.count()) > 0 ? "publicado" : (await recusa.count()) > 0 ? "recusado" : "esperando",
      { timeout: PRAZO, message: "nem o toast de publicado nem um motivo ancorado no nó apareceram" },
    )
    .not.toBe("esperando");
  if ((await recusa.count()) > 0) {
    throw new Error(`o publish RECUSOU o fluxo: ${(await recusa.textContent())?.trim()}`);
  }
  await expect(toast).toBeVisible({ timeout: PRAZO });
}

/**
 * Texto cortado, MEDIDO: um elemento com `truncate`/`line-clamp` esconde o que
 * passa da caixa, e a diferença entre `scrollWidth` e `clientWidth` (ou as
 * alturas) é a única forma de saber disso sem olhar. Ler o `textContent` não
 * serve: ele traz a frase inteira mesmo quando a tela mostra reticências.
 */
async function cortes(page: Page, seletor: string): Promise<Array<{ texto: string; w: [number, number]; h: [number, number] }>> {
  return page.locator(seletor).evaluateAll((els) =>
    els
      .map((el) => ({
        texto: el.textContent ?? "",
        w: [el.scrollWidth, el.clientWidth] as [number, number],
        h: [el.scrollHeight, el.clientHeight] as [number, number],
      }))
      // 1px de folga: o arredondamento do zoom do canvas produz meio pixel de
      // diferença em elemento que NÃO está cortado.
      .filter((m) => m.w[0] > m.w[1] + 1 || m.h[0] > m.h[1] + 1),
  );
}

/**
 * Fecha o painel do nó sem clicar no canvas. O Radix deixa `pointer-events:
 * none` no `body` por um instante depois que um `Select` fecha; sob carga isso
 * demora, e o clique no canvas é engolido pelo `<html>` (medido: 178 tentativas
 * em 7 minutos). Esperar o `body` voltar a aceitar ponteiro é o que falta — o
 * Esc não serve: o painel deste canvas não fecha por teclado.
 */
async function fecharPainel(page: Page): Promise<void> {
  await page
    .waitForFunction(() => document.body.style.pointerEvents !== "none", null, { timeout: 15_000 })
    .catch(() => {});
  // Ponto vazio do canvas, longe do cabeçalho fixo (que intercepta o clique no
  // canto superior) e dos nós, que este teste posiciona à direita.
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 420 } });
  await expect(page.getByTestId("node-config-sheet")).toHaveCount(0, { timeout: PRAZO });
}

/** Cria uma etapa própria pela API pública e devolve id e nome do funil. */
async function criarEtapa(page: Page, nome: string): Promise<{ funilId: string; etapaId: string; funilNome: string }> {
  const funisRes = await page.request.get("/api/v1/pipelines");
  expect(funisRes.ok(), `listar funis: ${funisRes.status()}`).toBe(true);
  const funis = ((await funisRes.json()) as { data: Array<{ id: string; name: string }> }).data;
  const funil = funis[0]!;
  const res = await page.request.post(`/api/v1/pipelines/${funil.id}/stages`, { data: { name: nome } });
  expect(res.ok(), `criar etapa: ${res.status()} ${await res.text()}`).toBe(true);
  const dados = ((await res.json()) as { data: { etapas: Array<{ id: string; name: string }> } }).data;
  const etapa = dados.etapas.find((e) => e.name === nome);
  expect(etapa, `etapa "${nome}" não voltou`).toBeDefined();
  return { funilId: funil.id, etapaId: etapa!.id, funilNome: funil.name };
}

test.describe("o cartão do nó diz o que o motor faz", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });
  test.setTimeout(420_000);

  test("regra de etapa pelo nome, texto inteiro no cartão e publish que recusa regra vazia", async ({ page }) => {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await login(page, creds.users.manager!.email);

    const carimbo = Date.now();
    const { etapaId, funilNome } = await criarEtapa(page, `E2E Cartões ${carimbo}`);
    const nomeDaEtapa = `E2E Cartões ${carimbo} · ${funilNome}`;

    await novoFluxo(page, `E2E Cartões ${carimbo}`);
    await page.getByTestId("palette-add-trigger").click();
    await page.getByTestId("palette-add-condition").click();
    await page.getByTestId("palette-add-ai_classify").click();
    await page.getByTestId("palette-add-repeat").click();

    const [condicaoId] = await idPorPrefixo(page, "condition");
    const [classifyId] = await idPorPrefixo(page, "ai_classify");
    const [repeatId] = await idPorPrefixo(page, "repeat");
    if (!condicaoId || !classifyId || !repeatId) throw new Error("ids de nó ausentes");

    await zoomAte(page, 1);
    const canvas = await page.getByTestId("flow-canvas").boundingBox();
    if (!canvas) throw new Error("canvas sem bounding box");
    await moverNo(page, condicaoId, canvas.x + 300, canvas.y + 150);
    await moverNo(page, classifyId, canvas.x + 800, canvas.y + 150);
    await moverNo(page, repeatId, canvas.x + 800, canvas.y + 500);

    // ─── 1. a regra de etapa: escolhida numa lista, nunca digitada ────────
    await page.locator(`[data-testid="node-card-${condicaoId}"]`).click();
    const painel = page.getByTestId("node-config-panel");
    await expect(painel).toBeVisible({ timeout: PRAZO });

    await painel.getByRole("combobox", { name: "Como as regras decidem o caminho" }).click();
    await page.getByRole("option", { name: "Uma saída por regra" }).click();

    const regra1 = painel.getByTestId("condition-check-0");
    await regra1.getByRole("combobox", { name: "Valor" }).click();
    await page.getByRole("option", { name: nomeDaEtapa }).click();
    await expect(painel).toContainText(`O lead está na etapa “${nomeDaEtapa}”`);

    // A segunda regra é numérica: o formulário grava NÚMERO, e é o que o motor compara.
    await painel.getByRole("button", { name: "Condição", exact: true }).click();
    const regra2 = painel.getByTestId("condition-check-1");
    await regra2.getByRole("combobox", { name: "Campo" }).click();
    await page.getByRole("option", { name: "Passos já dados no fluxo", exact: true }).click();
    // O operador é escolhido de propósito: trocar o campo preserva o operador
    // quando ele continua válido (a regra nasce em "é exatamente" por vir de
    // "está na etapa"), e quem monta o fluxo escolhe o que quer comparar.
    await regra2.getByRole("combobox", { name: "Operador" }).click();
    await page.getByRole("option", { name: "é pelo menos", exact: true }).click();
    await regra2.getByLabel("Valor").fill("3");
    await regra2.getByLabel("Valor").blur();

    await fecharPainel(page);

    // ─── 2. o cartão: nome da etapa, sem identificador, sem corte ─────────
    const cartaoCondicao = page.locator(`[data-testid="node-card-${condicaoId}"]`);
    await expect(page.getByTestId(`node-branch-${condicaoId}-regra-1`)).toHaveText(
      `O lead está na etapa “${nomeDaEtapa}”`,
    );
    await expect(page.getByTestId(`node-branch-${condicaoId}-regra-2`)).toHaveText(
      "O fluxo já deu pelo menos 3 passos",
    );
    await expect(page.getByTestId(`node-branch-${condicaoId}-else`)).toHaveText("Nenhuma delas");
    expect(await cartaoCondicao.textContent(), "o identificador da etapa não pode chegar à tela").not.toMatch(UUID_RX);
    // Nenhuma saída marcada como "etapa que não existe": a regra aponta para uma etapa viva.
    await expect(page.locator(`[data-testid^="node-branch-${condicaoId}-"][data-regra-sem-etapa]`)).toHaveCount(0);

    // ─── 3. os outros dois cartões do print ──────────────────────────────
    await expect(page.locator(`[data-testid="node-card-${classifyId}"]`)).toContainText("2 classes · espera 15 min");
    await expect(page.getByTestId(`node-branch-${classifyId}-Interessado`)).toHaveText("Interessado");
    await expect(page.getByTestId(`node-branch-${classifyId}-no_reply`)).toHaveText("Sem resposta");
    // "Sempre" ao lado de saídas específicas prometia o que o motor não faz.
    await expect(page.getByTestId(`node-branch-${classifyId}-else`)).toHaveText("Outros casos");
    await expect(page.locator(`[data-testid="node-card-${repeatId}"]`)).toContainText("até 12 voltas");
    await expect(page.getByTestId(`node-branch-${repeatId}-else`)).toHaveText("Outros casos");
    for (const cartao of [condicaoId, classifyId, repeatId]) {
      expect(await page.locator(`[data-testid="node-card-${cartao}"]`).textContent()).not.toMatch(/\bgrace\b/i);
    }

    // ─── 4. A MEDIDA: nada cortado, em nenhum cartão ─────────────────────
    const cortados = await cortes(page, '[data-testid^="node-card-"] p, [data-testid^="node-branch-"] span:not([aria-hidden])');
    expect(cortados, `texto cortado no cartão: ${JSON.stringify(cortados)}`).toEqual([]);

    // A linha entre dois passos precisa ser visível: token do tema, nunca o cinza da lib.
    await ligar(page, (await idPorPrefixo(page, "trigger"))[0]!, condicaoId);
    const traco = await page
      .locator(".react-flow__edge-path")
      .first()
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(traco, "a aresta ficou no cinza padrão do XYFlow").not.toBe("rgb(177, 177, 183)");

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "cartoes-01-regra-de-etapa-pelo-nome.png"), fullPage: true });

    // ─── 5. regra sem valor não publica, e o aviso diz QUAL ──────────────
    await page.locator(`[data-testid="node-card-${condicaoId}"]`).click();
    await expect(painel).toBeVisible({ timeout: PRAZO });
    await painel.getByRole("button", { name: "Condição", exact: true }).click(); // regra 3, em branco
    await fecharPainel(page);
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByTestId("dirty-indicator")).toHaveCount(0, { timeout: PRAZO });
    await page.getByTestId("publish-button").click();
    // O cartão mostra o PRIMEIRO erro inline e junta TODOS no `title` — num grafo
    // ainda incompleto o primeiro é estrutural, então a regra nomeada se confere
    // no título, que é onde o produto publica a lista inteira.
    await expect(page.locator(`[data-testid="node-error-${condicaoId}"]`)).toBeVisible({ timeout: PRAZO });
    await expect(page.locator(`[data-testid="node-card-${condicaoId}"]`)).toHaveAttribute(
      "title",
      /Regra 3 sem valor/,
      { timeout: PRAZO },
    );
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "cartoes-02-regra-sem-valor-nao-publica.png"), fullPage: true });
  });

  test("a consequência: o lead na etapa escolhida sai pela saída daquela regra", async ({ page }) => {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await login(page, creds.users.manager!.email);

    const carimbo = Date.now();
    const { funilId, etapaId, funilNome } = await criarEtapa(page, `E2E Etapa ${carimbo}`);
    const nomeDaEtapa = `E2E Etapa ${carimbo} · ${funilNome}`;
    const flowId = await novoFluxo(page, `E2E Etapa ${carimbo}`);

    await page.getByTestId("palette-add-trigger").click();
    await page.getByTestId("palette-add-condition").click();
    await page.getByTestId("palette-add-end").click();
    await page.getByTestId("palette-add-end").click();
    const [gatilhoId] = await idPorPrefixo(page, "trigger");
    const [condicaoId] = await idPorPrefixo(page, "condition");
    const [fimDaEtapa, fimDoResto] = await idPorPrefixo(page, "end");
    if (!gatilhoId || !condicaoId || !fimDaEtapa || !fimDoResto) throw new Error("ids de nó ausentes");

    await zoomAte(page, 1);
    const canvas = await page.getByTestId("flow-canvas").boundingBox();
    if (!canvas) throw new Error("canvas sem bounding box");
    await moverNo(page, gatilhoId, canvas.x + 200, canvas.y + 80);
    await moverNo(page, condicaoId, canvas.x + 200, canvas.y + 240);
    await moverNo(page, fimDaEtapa, canvas.x + 600, canvas.y + 180);
    await moverNo(page, fimDoResto, canvas.x + 600, canvas.y + 380);

    await page.locator(`[data-testid="node-card-${condicaoId}"]`).click();
    const painel = page.getByTestId("node-config-panel");
    await expect(painel).toBeVisible({ timeout: PRAZO });
    await painel.getByRole("combobox", { name: "Como as regras decidem o caminho" }).click();
    await page.getByRole("option", { name: "Uma saída por regra" }).click();
    await painel.getByTestId("condition-check-0").getByRole("combobox", { name: "Valor" }).click();
    await page.getByRole("option", { name: nomeDaEtapa }).click();
    await fecharPainel(page);

    await ligar(page, gatilhoId, condicaoId);
    await ligar(page, condicaoId, fimDaEtapa, "regra-1");
    await ligar(page, condicaoId, fimDoResto, "else");

    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByTestId("dirty-indicator")).toHaveCount(0, { timeout: PRAZO });
    await publicarEExigirSucesso(page);

    async function matricular(nome: string, stageId: string): Promise<string> {
      const contatoRes = await page.request.post("/api/v1/contacts", { data: { display_name: nome } });
      expect(contatoRes.ok(), `criar contato: ${contatoRes.status()}`).toBe(true);
      const contatoId = ((await contatoRes.json()) as { data: { contact: { id: string } } }).data.contact.id;
      const leadRes = await page.request.post("/api/v1/leads", {
        data: { pipeline_id: funilId, stage_id: stageId, title: nome, contact_id: contatoId },
      });
      expect(leadRes.ok(), `criar lead: ${leadRes.status()} ${await leadRes.text()}`).toBe(true);
      const res = await page.request.post("/api/v1/ai/followups/enrollments", {
        data: { pointer_id: flowId, contact_id: contatoId },
      });
      expect(res.ok(), `matricular: ${res.status()} ${await res.text()}`).toBe(true);
      return ((await res.json()) as { data: { id: string } }).data.id;
    }

    // Um lead NA etapa da regra, e outro em qualquer outra etapa do mesmo funil.
    const outraEtapa = await criarEtapa(page, `E2E Outra ${carimbo}`);
    const naEtapa = await matricular(`E2E na etapa ${carimbo}`, etapaId);
    const foraDaEtapa = await matricular(`E2E fora da etapa ${carimbo}`, outraEtapa.etapaId);

    for (let i = 0; i < 4; i++) {
      const tick = await page.request.post("/api/v1/cron/followup-flow-worker", {
        headers: { authorization: `Bearer ${process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo"}` },
      });
      expect(tick.ok(), `tick ${i + 1}: ${tick.status()} ${await tick.text()}`).toBe(true);
    }

    const listaRes = await page.request.get("/api/v1/ai/followups/enrollments");
    expect(listaRes.ok()).toBe(true);
    const lista = ((await listaRes.json()) as { data: Array<{ id: string; current_node_id: string }> }).data;
    const doDaEtapa = lista.find((m) => m.id === naEtapa)!;
    const doResto = lista.find((m) => m.id === foraDaEtapa)!;

    // ANTES deste conserto os dois terminavam no mesmo lugar: a regra de etapa
    // comparava o texto digitado com o `stage_id` e nunca era verdadeira.
    expect(
      doDaEtapa.current_node_id,
      `na etapa parou em ${doDaEtapa.current_node_id} (esperado ${fimDaEtapa})`,
    ).toBe(fimDaEtapa);
    expect(doResto.current_node_id).toBe(fimDoResto);

    await page.goto(`/app/ai/followups/${flowId}`);
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "cartoes-03-dois-leads-duas-saidas.png"), fullPage: true });
  });
});
