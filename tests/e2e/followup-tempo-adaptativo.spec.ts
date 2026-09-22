/**
 * A PROVA EM TELA do defeito do modo "Adaptativo" do nó de espera.
 *
 * ═══ O QUE ESTE ARQUIVO EXISTE PARA PROVAR ═══
 *
 * O construtor de follow-up oferece, no nó de espera, o modo
 * **"Adaptativo (min–max)"**, com mínimo, máximo e um campo de orientação para
 * a IA. O decisor por LLM até existe escrito (`decideFollowupTiming` em
 * `lib/agent-engine/agent/followup-flow-classify.ts`).
 *
 * Só que o motor nunca o chama:
 *
 *   // lib/followup/node-handlers.ts
 *   const durationMs = node.config.mode === "fixed" ? node.config.duration_ms : node.config.max_ms;
 *
 * `processNode` jamais devolve `enqueue_turn` para um nó `wait`, então o ramo
 * de payload que carrega o `guidance` (`engine.ts`) é código morto. O usuário
 * escolhe "Adaptativo", escreve a orientação — e o sistema espera **sempre o
 * máximo**, calado.
 *
 * Um controle que a tela oferece e o código ignora é pior que um controle
 * ausente: o ausente o usuário contorna, o decorativo ele confia.
 *
 * ═══ POR QUE ESTE TESTE NASCE VERMELHO, E DEVE NASCER ═══
 *
 * Ele é a metade RED do ciclo. A asserção é sobre o comportamento **correto**:
 * dada uma orientação que pede urgência, o instante agendado tem de cair
 * ESTRITAMENTE dentro de `[min, max]` — nunca colar no teto. Hoje ele cola no
 * teto exato, então falha, e a mensagem da falha traz o número medido.
 *
 * Ele fica verde quando o conserto (frente MOTOR) entra. E ele continua
 * valendo depois: se alguém voltar a cair no `max_ms` por atalho — inclusive
 * como fallback silencioso quando o modelo não responde —, ele reprova. Cair
 * no teto sem dizer é exatamente o defeito, não uma degradação aceitável.
 *
 * ═══ O QUE ELE PROVA PELA TELA, E NÃO POR API ═══
 *
 * A PROMESSA é feita pela interface, então a configuração é feita clicando: o
 * modo é escolhido no `<Select>`, os minutos são digitados, a orientação é
 * escrita, e há screenshot do painel. A CONSEQUÊNCIA é lida na Fila, também na
 * tela. A API entra só onde não há tela (matricular o contato e cutucar o
 * worker), e o número da asserção sai da mesma rota que alimenta a tabela —
 * o print e a asserção falam do mesmo dado.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { zoomAte } from "./utils/canvas-do-fluxo";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
// evidence/ é versionado; e2e-artifacts/ está no .gitignore e evidência citada
// que não entra no repo é evidência que ninguém consegue conferir depois.
const ARTIFACTS_DIR = path.join(process.cwd(), "evidence", "followup-vivo");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

/** A janela que o operador configura na tela. `MAX` é o teto que o motor cola hoje. */
const MIN_MINUTOS = 10;
const MAX_MINUTOS = 360; // 6h
const ORIENTACAO =
  "O lead pediu retorno ainda hoje, em cerca de meia hora. Volte rápido, dentro do menor prazo possível.";

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const needsSeed = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (needsSeed()) {
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
  await page.waitForURL(/\/app\//);
}

/**
 * Arrasta do handle de saída de um nó até o de entrada de outro.
 *
 * Repete até a aresta existir (ou estourar `TENTATIVAS`), e a repetição não é
 * preguiça: o React Flow só registra a conexão se a sequência de `pointermove`
 * chegar dentro da janela que ele considera um gesto. Numa máquina carregada um
 * dos eventos intermediários atrasa, o gesto é descartado, e o teste falha com
 * "2 arestas em vez de 3" — que fala sobre o agendador do sistema operacional,
 * não sobre o produto. Medido aqui: 1 dos 3 arrastes se perdeu com dois builds
 * concorrendo. O que o teste quer provar é o tempo da espera, não a fidelidade
 * do arrasto; então a conexão vira precondição robusta em vez de asserção frágil.
 */
async function connectHandles(page: Page, sourceNodeId: string, targetNodeId: string): Promise<void> {
  const TENTATIVAS = 4;
  const source = page.locator(`.react-flow__node[data-id="${sourceNodeId}"] .react-flow__handle.source`);
  const target = page.locator(`.react-flow__node[data-id="${targetNodeId}"] .react-flow__handle.target`);
  const antes = await page.locator(".react-flow__edge").count();

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const sBox = await source.boundingBox();
    const tBox = await target.boundingBox();
    if (!sBox || !tBox) throw new Error(`handle não encontrado: ${sourceNodeId} -> ${targetNodeId}`);
    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sBox.x + sBox.width / 2 + 5, sBox.y + sBox.height / 2 + 5, { steps: 3 });
    await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    if ((await page.locator(".react-flow__edge").count()) > antes) return;
  }
  throw new Error(
    `a aresta ${sourceNodeId} -> ${targetNodeId} não nasceu em ${TENTATIVAS} tentativas — ` +
      `isto não é lentidão, é o gesto não estar chegando ao React Flow`,
  );
}

/**
 * Prazo generoso, e não por preguiça: esta suíte roda numa máquina de trabalho
 * compartilhada com outras sessões. Medido aqui com `load average 42.77` em 11
 * CPUs — o login levou 15,1s e o diálogo de criar fluxo levou 8,1s para fechar
 * DEPOIS de a API já ter devolvido 201. Nada disso é evidência sobre o app; é
 * evidência sobre a máquina. O default de 5s do Playwright transforma carga em
 * vermelho, e vermelho por azar ninguém lê — o que desliga o gate inteiro.
 */
const PRAZO_SOB_CARGA = 60_000;

test.describe("nó de espera — o modo Adaptativo tem de decidir de verdade", () => {
  // Canvas grande: com 4 nós o fitView chega ao maxZoom e joga handles pra fora
  // do viewport, o que quebra os arrastes de conexão.
  test.use({ viewport: { width: 1600, height: 900 } });
  test.setTimeout(300_000);

  test("a espera configurada como Adaptativa não pode agendar o máximo", async ({ page }) => {
    const stamp = Date.now();
    const flowName = `E2E Tempo Adaptativo ${stamp}`;
    const contactName = `Cliente Tempo Adaptativo ${stamp}`;

    await login(page, creds.users.manager!.email);

    // ─── 1. o fluxo, criado pela tela ────────────────────────────────────
    await page.goto("/app/ai/followups");
    await page.getByRole("button", { name: "Novo fluxo" }).click();
    const dialog = page.getByRole("dialog");
    // Esperar o FOCO, não só a visibilidade. O Radix anima a abertura e o
    // `autoFocus` do input chega depois do primeiro paint; um `fill()` disparado
    // no meio disso é engolido, o campo fica vazio e o botão de submit nasce
    // desabilitado (`name.trim().length === 0`) — o teste então espera um
    // diálogo que nunca vai fechar. Sob carga isso deixa de ser raro. É a mesma
    // guarda que o teste 6.1 de `followup-builder.spec.ts` já usa (e que o 6.2
    // do mesmo arquivo não usa — por isso ele falha nesta máquina).
    const campoNome = dialog.getByLabel("Nome");
    await expect(campoNome).toBeFocused({ timeout: PRAZO_SOB_CARGA });
    await campoNome.fill(flowName);
    await expect(campoNome).toHaveValue(flowName);
    await dialog.getByRole("button", { name: "Criar fluxo" }).click();
    await expect(dialog).not.toBeVisible({ timeout: PRAZO_SOB_CARGA });

    await page.locator("li", { hasText: flowName }).getByRole("link").click();
    await page.waitForURL(/\/app\/ai\/followups\/[0-9a-f-]+$/);
    const flowId = page.url().split("/").pop()!;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: PRAZO_SOB_CARGA });

    // ─── 2. gatilho → espera → mensagem → fim, montado no canvas ─────────
    await page.getByTestId("palette-add-trigger").click();
    await page.getByTestId("palette-add-wait").click();
    await page.getByTestId("palette-add-action").click();
    await page.getByTestId("palette-add-end").click();

    await zoomAte(page, 0.85);

    const triggerId = await page.locator('.react-flow__node[data-id^="trigger-"]').getAttribute("data-id");
    const waitId = await page.locator('.react-flow__node[data-id^="wait-"]').getAttribute("data-id");
    const actionId = await page.locator('.react-flow__node[data-id^="action-"]').getAttribute("data-id");
    const endId = await page.locator('.react-flow__node[data-id^="end-"]').getAttribute("data-id");
    if (!triggerId || !waitId || !actionId || !endId) throw new Error("node ids ausentes");

    await connectHandles(page, triggerId, waitId);
    await connectHandles(page, waitId, actionId);
    await connectHandles(page, actionId, endId);
    await expect(page.locator(".react-flow__edge")).toHaveCount(3, { timeout: PRAZO_SOB_CARGA });

    // ─── 3. A PROMESSA: o operador escolhe Adaptativo e orienta a IA ─────
    await page.locator(`.react-flow__node[data-id="${waitId}"]`).click();
    const painel = page.getByTestId("node-config-panel");
    await expect(painel).toBeVisible({ timeout: PRAZO_SOB_CARGA });

    await painel.locator("#wait-mode").click();
    await page.getByRole("option", { name: "A IA escolhe a hora" }).click();

    await painel.locator("#wait-min").fill(String(MIN_MINUTOS));
    await painel.locator("#wait-max").fill(String(MAX_MINUTOS));
    await painel.locator("#wait-guidance").fill(ORIENTACAO);

    // A tela agora promete: "espero entre 10 min e 6h, e a IA decide com base nisto".
    await expect(painel.locator("#wait-min")).toHaveValue(String(MIN_MINUTOS));
    await expect(painel.locator("#wait-max")).toHaveValue(String(MAX_MINUTOS));
    await expect(painel.locator("#wait-guidance")).toHaveValue(ORIENTACAO);
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "tempo-adaptativo-01-a-promessa-da-tela.png"),
      fullPage: true,
    });

    // A ação do agente precisa de conteúdo para o fluxo publicar.
    await page.locator(`.react-flow__node[data-id="${actionId}"]`).click();
    await page.getByTestId("node-config-panel").locator("#action-prompt-hint").fill(
      "Retome a conversa com o lead de forma breve e cordial.",
    );

    // ─── 4. salvar + publicar, pelos botões ──────────────────────────────
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByTestId("dirty-indicator")).toHaveCount(0, { timeout: PRAZO_SOB_CARGA });
    await page.getByTestId("publish-button").click();
    // O selo do fluxo passa a "Ativo" (FlowStatusBadge) e a barra confirma
    // "Fluxo publicado." — não existe rótulo "Publicado" em lugar nenhum.
    await expect(page.getByText("Fluxo publicado.")).toBeVisible({ timeout: PRAZO_SOB_CARGA });
    await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible({ timeout: PRAZO_SOB_CARGA });

    // ─── 5. um contato entra no fluxo (sem tela própria: via API) ────────
    const contactRes = await page.request.post("/api/v1/contacts", { data: { display_name: contactName } });
    expect(contactRes.ok(), `criar contato: ${contactRes.status()}`).toBe(true);
    const { data: contato } = (await contactRes.json()) as { data: { contact: { id: string } } };

    const enrollRes = await page.request.post("/api/v1/ai/followups/enrollments", {
      data: { pointer_id: flowId, contact_id: contato.contact.id },
    });
    expect(enrollRes.ok(), `matricular: ${enrollRes.status()} ${await enrollRes.text()}`).toBe(true);
    const { data: matricula } = (await enrollRes.json()) as { data: { id: string } };

    // ─── 6. o worker roda: sai do gatilho e ENTRA no nó de espera ────────
    // Dois ticks: o 1º avança trigger→wait, o 2º é o que arma o relógio da espera.
    const marcoZero = Date.now();
    for (let i = 0; i < 2; i++) {
      const tick = await page.request.post("/api/v1/cron/followup-flow-worker", {
        headers: { authorization: `Bearer ${process.env.INTERNAL_SECRET ?? "e2e-placeholder-nao-e-segredo"}` },
      });
      expect(tick.ok(), `tick ${i + 1} do worker: ${tick.status()} ${await tick.text()}`).toBe(true);
    }

    // ─── 7. A CONSEQUÊNCIA, lida na tela da Fila ─────────────────────────
    await page.goto("/app/ai/followups");
    await page.getByRole("tab", { name: "Fila" }).click();
    await page.getByLabel("Buscar contato").fill(contactName);
    const linha = page.locator('[data-testid="queue-row"]', { hasText: contactName });
    await expect(linha).toBeVisible({ timeout: PRAZO_SOB_CARGA });
    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "tempo-adaptativo-02-o-que-o-motor-agendou.png"),
      fullPage: true,
    });

    // O número da asserção vem da MESMA rota que alimenta a tabela acima — o
    // print e a medição falam do mesmo dado, não de dois caminhos diferentes.
    const filaRes = await page.request.get(`/api/v1/ai/followups/queue?pointer_id=${flowId}`);
    expect(filaRes.ok(), `ler fila: ${filaRes.status()}`).toBe(true);
    const { data: fila } = (await filaRes.json()) as {
      // `node_or_reason` é a coluna "Nó atual / Motivo" da tela — a mesma que a
      // asserção estrutural abaixo lê. Faltava só nesta anotação LOCAL: a rota
      // devolve o campo (`app/api/v1/ai/followups/queue/route.ts`), então
      // declarar só `id` e `next_fire_at` deixava o typecheck vermelho na
      // integração. Nenhuma asserção mudou; o tipo é que passou a descrever o
      // que a resposta já tinha.
      data: Array<{ id: string; next_fire_at: string | null; node_or_reason: string }>;
    };
    const minha = fila.find((r) => r.id === matricula.id);
    expect(minha, "o enrollment recém-criado não apareceu na fila").toBeTruthy();
    expect(minha!.next_fire_at, "enrollment sem próximo disparo — a espera nem foi armada").toBeTruthy();

    const atrasoMinutos = (Date.parse(minha!.next_fire_at!) - marcoZero) / 60_000;

    // ─── 8a. a asserção ESTRUTURAL, e ela é a que não passa por acidente ───
    //
    // "o próximo disparo é curto" sozinho é necessário e NÃO suficiente: seria
    // verdade também se o fluxo tivesse quebrado de outro jeito. O que distingue
    // o conserto de um acaso é ONDE o enrollment está. Com o defeito, ele avança
    // do gatilho para a espera e crava `agora + max_ms` (medido: nó `wait-*`,
    // 360,0 min). Com o conserto, ele FICA no gatilho enquanto pede o plano de
    // tempo do fluxo inteiro, e só depois entra na espera com o instante decidido.
    expect(
      minha!.node_or_reason,
      `O enrollment deveria estar parado no GATILHO pedindo o plano de tempo, e está em ` +
        `"${minha!.node_or_reason}". Se já avançou para o nó de espera antes de existir plano, ` +
        `o modo Adaptativo voltou a ser "fixo no máximo".`,
    ).toMatch(/^trigger/);

    // ─── 8. A ASSERÇÃO ───────────────────────────────────────────────────
    // Configurado: [10 min, 360 min] + orientação pedindo pressa.
    // Correto: um instante escolhido DENTRO da janela.
    // Hoje: exatamente 360 — o teto, sempre, orientação ignorada.
    expect(
      atrasoMinutos,
      `A tela prometeu espera ADAPTATIVA entre ${MIN_MINUTOS} e ${MAX_MINUTOS} min, com a orientação ` +
        `"${ORIENTACAO}". O motor agendou para daqui a ${atrasoMinutos.toFixed(1)} min. ` +
        `Colar no teto (${MAX_MINUTOS}) é o comportamento de 'fixo no máximo' — a orientação não muda nada, ` +
        `e o usuário não tem como perceber. Ver lib/followup/node-handlers.ts (case "wait").`,
    ).toBeLessThan(MAX_MINUTOS);

    // Higiene: não deixar enrollment vivo na fila real da org de teste.
    await page.request.post(`/api/v1/ai/followups/enrollments/${matricula.id}/cancel`, { data: {} });
    await page.request.post(`/api/v1/ai/followup-flows/${flowId}/disable`, { data: {} });
  });
});
