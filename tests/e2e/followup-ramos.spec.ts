/**
 * A PROVA EM TELA da queixa original, dita com as palavras de quem reclamou:
 *
 *   "Quando adicionamos várias regras, o node continua tendo só uma bolinha de
 *    saída, e não conseguimos definir qual aresta sai de qual regra."
 *
 * Não era defeito de desenho. O nó de condição dobrava N regras num único
 * booleano antes de chegar ao canvas, e a aresta só sabia dizer sim/não — não
 * existia o que gravar numa segunda bolinha. Desenhar mais pontos sem mudar o
 * contrato só teria trocado um problema por outro.
 *
 * O que este arquivo prova, clicando:
 *   1. duas regras produzem DUAS bolinhas separadas, cada uma com nome legível,
 *      mais a de "nenhuma delas";
 *   2. uma aresta sai de cada uma, para destinos diferentes, e o fluxo publica;
 *   3. dois leads com etiquetas diferentes terminam em nós diferentes — a
 *      consequência, não só a promessa da tela.
 *
 * Mede também a altura do card com 5 ramos, por ferramenta e não a olho: um nó
 * que ramifica cresce, e crescer sem limite é o jeito de transformar a correção
 * num problema novo.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "./helpers/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = ".e2e-creds.json";
const ARTIFACTS_DIR = "evidence/followup-vivo";

/**
 * Prazo generoso porque esta máquina roda saturada por outras sessões (medido:
 * login em 15,1s). Vermelho por carga ninguém lê — e suíte que reprova por azar
 * desliga o gate inteiro.
 */
const PRAZO = 60_000;

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    // O seed é do maestro (ele rotaciona o TOTP do admin e derruba o run alheio).
    // Só cai aqui se o arquivo não tiver sido copiado — e aí é melhor falhar alto.
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

/**
 * Arrasta de uma saída até a entrada de outro nó. `ramo` só existe em nó que
 * ramifica — um nó de saída única tem a bolinha de sempre, sem id, e o seletor
 * por `data-handleid` não casaria com ela.
 */
async function ligar(
  page: Page,
  origem: string,
  destino: string,
  ramo?: string,
): Promise<void> {
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

async function moverNo(page: Page, nodeId: string, x: number, y: number): Promise<void> {
  const card = page.locator(`[data-testid="node-card-${nodeId}"]`);
  const box = await card.boundingBox();
  if (!box) throw new Error(`nó sem bounding box: ${nodeId}`);
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
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

/** Altura real do card, pela ferramenta — nunca a olho. */
async function alturaDoCard(page: Page, nodeId: string): Promise<number> {
  return page.locator(`[data-testid="node-card-${nodeId}"]`).evaluate((el) => el.getBoundingClientRect().height);
}

test.describe("condição com várias regras — uma bolinha por regra", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });
  test.setTimeout(420_000);

  test("duas regras dão duas saídas separadas, e dois leads seguem caminhos diferentes", async ({ page }) => {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await login(page, creds.users.manager!.email);

    // ─── 1. fluxo novo ───────────────────────────────────────────────────
    const nomeDoFluxo = `E2E Ramos ${Date.now()}`;
    await page.goto("/app/ai/followups");
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialogo = page.getByRole("dialog");
    const campoNome = dialogo.getByLabel("Nome");
    // O Radix anima a abertura e o autoFocus chega DEPOIS do primeiro paint: um
    // fill no meio disso é engolido e o botão nasce desabilitado.
    await expect(campoNome).toBeFocused({ timeout: PRAZO });
    await campoNome.fill(nomeDoFluxo);
    await expect(campoNome).toHaveValue(nomeDoFluxo);
    await dialogo.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialogo).not.toBeVisible({ timeout: PRAZO });
    await page.locator("li", { hasText: nomeDoFluxo }).getByRole("link").click();
    await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/, { timeout: PRAZO });
    const flowId = page.url().split("/").pop()!;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO });

    // ─── 2. os nós ───────────────────────────────────────────────────────
    await page.getByTestId("palette-add-trigger").click();
    await page.getByTestId("palette-add-condition").click();
    await page.getByTestId("palette-add-end").click();
    await page.getByTestId("palette-add-end").click();
    await page.getByTestId("palette-add-end").click();

    const [gatilhoId] = await idPorPrefixo(page, "trigger");
    const [condicaoId] = await idPorPrefixo(page, "condition");
    const [fimVipId, fimAtrasadoId, fimRestoId] = await idPorPrefixo(page, "end");
    if (!gatilhoId || !condicaoId || !fimVipId || !fimAtrasadoId || !fimRestoId) {
      throw new Error("ids de nó ausentes");
    }

    // Estabiliza o zoom antes de qualquer conta em pixels: o fitView re-ajusta a
    // cada nó medido pela primeira vez e move o alvo no meio do caminho.
    await zoomAte(page, 0.85);
    await page.waitForTimeout(300);

    const canvas = await page.getByTestId("flow-canvas").boundingBox();
    if (!canvas) throw new Error("canvas sem bounding box");
    const em = (dx: number, dy: number): [number, number] => [canvas.x + dx, canvas.y + dy];
    await moverNo(page, gatilhoId, ...em(160, 60));
    await moverNo(page, condicaoId, ...em(160, 200));
    await moverNo(page, fimVipId, ...em(560, 130));
    await moverNo(page, fimAtrasadoId, ...em(560, 300));
    await moverNo(page, fimRestoId, ...em(560, 470));

    // ─── 3. duas regras, no modo uma-saída-por-regra ─────────────────────
    const alturaDeUmaSaidaSo = await alturaDoCard(page, gatilhoId);

    await page.locator(`[data-testid="node-card-${condicaoId}"]`).click();
    const painel = page.getByTestId("node-config-panel");
    await expect(painel).toBeVisible({ timeout: PRAZO });

    await painel.getByRole("combobox", { name: "Como as regras decidem o caminho" }).click();
    await page.getByRole("option", { name: "Uma saída por regra" }).click();

    async function preencherRegra(idx: number, nome: string, valor: string): Promise<void> {
      await painel.getByLabel(`Nome da saída ${idx + 1}`).fill(nome);
      const bloco = painel.getByTestId(`condition-check-${idx}`);
      // ⚠️ PELO RÓTULO EM PORTUGUÊS, e não pelo valor de wire. Esta spec pedia
      // `"tag"` e `"contains"` — os nomes internos —, e ficou 7 MINUTOS clicando
      // num item que não existe mais. Não era ambiente: as duas frentes (ramos e
      // vocabulário) estavam verdes separadas e vermelhas juntas, porque a
      // segunda trocou justamente esses rótulos, que é a feature que Rafael
      // pediu. Pedir pelo nome interno num painel cujo propósito é NÃO falar em
      // código é o teste desmentindo o produto.
      //
      // E `contains` não é só outro nome: ele foi TIRADO do seletor de propósito
      // (`oferecido: false`), por ser duplicata de `eq` para etiqueta. O que o
      // usuário escolhe é "tem a etiqueta".
      await bloco.getByRole("combobox", { name: "Campo" }).click();
      await page.getByRole("option", { name: "Etiqueta do contato", exact: true }).click();
      await bloco.getByRole("combobox", { name: "Operador" }).click();
      await page.getByRole("option", { name: "tem a etiqueta", exact: true }).click();
      await bloco.getByLabel("Valor").fill(valor);
      await bloco.getByLabel("Valor").blur();
    }

    await preencherRegra(0, "Tem a etiqueta VIP", "vip");
    await painel.getByRole("button", { name: "Condição", exact: true }).click();
    await preencherRegra(1, "Tem a etiqueta atrasado", "atrasado");

    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId("node-config-sheet")).toHaveCount(0);

    // ─── 4. A QUEIXA, respondida na tela ─────────────────────────────────
    const saidas = page.locator(`[data-testid^="node-branch-${condicaoId}-"]`);
    await expect(saidas).toHaveCount(3); // duas regras + "nenhuma delas"
    await expect(page.getByTestId(`node-branch-${condicaoId}-regra-1`)).toHaveText("Tem a etiqueta VIP");
    await expect(page.getByTestId(`node-branch-${condicaoId}-regra-2`)).toHaveText("Tem a etiqueta atrasado");
    await expect(page.getByTestId(`node-branch-${condicaoId}-else`)).toHaveText("Nenhuma delas");

    // Cada saída tem a SUA bolinha, e são bolinhas distintas — não uma redesenhada.
    const bolinhas = page.locator(`.react-flow__node[data-id="${condicaoId}"] .react-flow__handle.source`);
    await expect(bolinhas).toHaveCount(3);
    const yDasBolinhas = await bolinhas.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().top)),
    );
    expect(new Set(yDasBolinhas).size, `bolinhas empilhadas no mesmo ponto: ${yDasBolinhas}`).toBe(3);

    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "ramos-01-uma-bolinha-por-regra.png"), fullPage: true });

    // ─── 5. o card cresce, mas quanto? medido, não estimado ──────────────
    const alturaCom2Regras = await alturaDoCard(page, condicaoId);
    await page.locator(`[data-testid="node-card-${condicaoId}"]`).click();
    await expect(painel).toBeVisible({ timeout: PRAZO });
    for (let i = 2; i < 5; i++) {
      await painel.getByRole("button", { name: "Condição", exact: true }).click();
    }
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(saidas).toHaveCount(6); // 5 regras + "nenhuma delas"
    const alturaCom5Regras = await alturaDoCard(page, condicaoId);
    console.info(
      `[medida] card: 1 saída = ${alturaDeUmaSaidaSo}px · 2 regras = ${alturaCom2Regras}px · 5 regras = ${alturaCom5Regras}px (${(alturaCom5Regras / alturaDeUmaSaidaSo).toFixed(2)}x)`,
    );
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "ramos-02-altura-com-5-regras.png"), fullPage: true });
    // Cinco saídas precisam de cinco pontos de ancoragem: existe um piso. O que
    // não pode é a linha da regra custar caro — daí a régua ser por RAMO.
    const custoPorRamo = (alturaCom5Regras - alturaDeUmaSaidaSo) / 6;
    expect(custoPorRamo, `cada ramo custou ${custoPorRamo.toFixed(1)}px de altura`).toBeLessThan(32);

    // Desfaz as 3 regras extras: o resto do teste é sobre as duas primeiras.
    await page.locator(`[data-testid="node-card-${condicaoId}"]`).click();
    await expect(painel).toBeVisible({ timeout: PRAZO });
    for (let i = 0; i < 3; i++) {
      await painel.getByRole("button", { name: "Remover condição" }).last().click();
    }
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    await expect(saidas).toHaveCount(3);

    // ─── 6. uma aresta por saída, para destinos diferentes ───────────────
    await ligar(page, gatilhoId, condicaoId); // gatilho tem saída única
    await ligar(page, condicaoId, fimVipId, "regra-1");
    await ligar(page, condicaoId, fimAtrasadoId, "regra-2");
    await ligar(page, condicaoId, fimRestoId, "else");
    await expect(page.locator(".react-flow__edge")).toHaveCount(4);

    // A aresta mostra o NOME do ramo de onde saiu — é isso que responde
    // "qual aresta sai de qual regra" quando o fluxo tem dez delas.
    await expect(page.locator(".react-flow__edge", { hasText: "Tem a etiqueta VIP" })).toHaveCount(1);
    await expect(page.locator(".react-flow__edge", { hasText: "Tem a etiqueta atrasado" })).toHaveCount(1);

    // ─── 7. publica ──────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByTestId("dirty-indicator")).toHaveCount(0, { timeout: PRAZO });
    await page.getByTestId("publish-button").click();
    await expect(page.getByText("Fluxo publicado.")).toBeVisible({ timeout: PRAZO });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "ramos-03-publicado.png"), fullPage: true });

    // ─── 8. A CONSEQUÊNCIA: dois leads, dois caminhos ────────────────────
    const funisRes = await page.request.get("/api/v1/pipelines");
    expect(funisRes.ok(), `listar funis: ${funisRes.status()}`).toBe(true);
    const funis = ((await funisRes.json()) as { data: Array<{ id: string }> }).data;
    const funilId = funis[0]!.id;
    // Não existe GET de etapas (só POST). Em vez de ler o funil por dentro do
    // banco, o teste CRIA a sua própria etapa pela API pública e usa o id que
    // ela devolve — de quebra não depende de como as etapas iniciais se chamam.
    const nomeDaEtapa = `E2E Ramos ${Date.now()}`;
    const etapaRes = await page.request.post(`/api/v1/pipelines/${funilId}/stages`, {
      data: { name: nomeDaEtapa },
    });
    expect(etapaRes.ok(), `criar etapa: ${etapaRes.status()} ${await etapaRes.text()}`).toBe(true);
    const funil = ((await etapaRes.json()) as { data: { etapas: Array<{ id: string; name: string }> } }).data;
    const etapaCriada = funil.etapas.find((e) => e.name === nomeDaEtapa);
    expect(etapaCriada, `etapa "${nomeDaEtapa}" não voltou em ${JSON.stringify(funil.etapas)}`).toBeDefined();
    const etapaId = etapaCriada!.id;

    async function matricular(nome: string, etiqueta: string): Promise<string> {
      const contatoRes = await page.request.post("/api/v1/contacts", { data: { display_name: nome } });
      expect(contatoRes.ok(), `criar contato ${nome}: ${contatoRes.status()}`).toBe(true);
      const contatoId = ((await contatoRes.json()) as { data: { contact: { id: string } } }).data.contact.id;

      const leadRes = await page.request.post("/api/v1/leads", {
        data: {
          pipeline_id: funilId,
          stage_id: etapaId,
          title: nome,
          contact_id: contatoId,
          tags: [etiqueta],
        },
      });
      expect(leadRes.ok(), `criar lead ${nome}: ${leadRes.status()} ${await leadRes.text()}`).toBe(true);

      const matriculaRes = await page.request.post("/api/v1/ai/followups/enrollments", {
        data: { pointer_id: flowId, contact_id: contatoId },
      });
      expect(matriculaRes.ok(), `matricular ${nome}: ${matriculaRes.status()} ${await matriculaRes.text()}`).toBe(true);
      return ((await matriculaRes.json()) as { data: { id: string } }).data.id;
    }

    const carimbo = Date.now();
    const matriculaVip = await matricular(`E2E Ramos VIP ${carimbo}`, "vip");
    const matriculaAtrasado = await matricular(`E2E Ramos Atrasado ${carimbo}`, "atrasado");

    // Ticks suficientes para sair do gatilho, passar pela condição e concluir.
    for (let i = 0; i < 4; i++) {
      const tick = await page.request.post("/api/v1/cron/followup-flow-worker", {
        headers: { authorization: `Bearer ${process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo"}` },
      });
      expect(tick.ok(), `tick ${i + 1}: ${tick.status()} ${await tick.text()}`).toBe(true);
    }

    const listaRes = await page.request.get("/api/v1/ai/followups/enrollments");
    expect(listaRes.ok(), `listar matrículas: ${listaRes.status()}`).toBe(true);
    const lista = ((await listaRes.json()) as {
      data: Array<{ id: string; current_node_id: string; status: string }>;
    }).data;
    const doVip = lista.find((m) => m.id === matriculaVip)!;
    const doAtrasado = lista.find((m) => m.id === matriculaAtrasado)!;

    expect(
      doVip.current_node_id,
      `VIP parou em ${doVip.current_node_id} (esperado ${fimVipId}); atrasado em ${doAtrasado.current_node_id}`,
    ).toBe(fimVipId);
    expect(doAtrasado.current_node_id).toBe(fimAtrasadoId);
    // O que o defeito impedia: dois leads, o MESMO nó de condição, destinos diferentes.
    expect(doVip.current_node_id).not.toBe(doAtrasado.current_node_id);

    await page.goto("/app/ai/followups");
    await page.getByRole("tab", { name: "Fila" }).click();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "ramos-04-dois-leads-dois-caminhos.png"), fullPage: true });
  });
});
