import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";

/**
 * A GRADE COMO AGENDA DE VERDADE — clicar num bloco marca, arrastar um card
 * remarca, e o que não dá para fazer DIZ por quê.
 *
 * ─── O estado anterior, e por que ele não aparecia em teste nenhum ───────
 *
 * `GradeDaAgenda` desenhava sete colunas, faixas de hora e cards, e só. Clicar
 * num espaço vazio não fazia nada; arrastar um card não fazia nada. Nenhuma
 * spec reprovava, porque nenhuma spec tentava — as irmãs (`agenda-marcar-pela-
 * tela`, `agenda-remarcar-e-cancelar`) entram pelo botão "Novo agendamento" e
 * pelo histórico, que são caminhos que existiam.
 *
 * ─── O jeito errado de consertar, que estas asserções fecham ─────────────
 *
 * Calcular o horário a partir do pixel clicado. A tela passaria a oferecer
 * instantes que a disponibilidade publicada não tem, o POST voltaria 422
 * `agenda_disponibilidade_invalida`, e a agenda discordaria do agente sobre o
 * que está livre — com a tela dizendo que deu certo. Por isso:
 *
 *   • o caso 1 assere O HORÁRIO que aparece no painel, não que "algo abriu";
 *   • o caso 3 assere o horário NA API depois do reload, não só na tela — card
 *     que se moveu visualmente e não persistiu é o pior desfecho, porque parece
 *     que funcionou;
 *   • o caso 5 mede com `boundingBox()`. A olho, 96px e 104px são o mesmo pixel.
 */

const RAIZ = path.resolve(__dirname, "../..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string; tipo_slug: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    // Mesma razão das irmãs: depender de outra spec ter semeado antes é
    // depender da ORDEM de execução, que é o defeito que `agenda-tela-do-produto`
    // já pagou. O seed é idempotente.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

async function entrar(page: Page, creds: Creds) {
  // `manager` e não `admin`: o admin do seed tem MFA com challenge, e esta spec
  // não é sobre login. Mesmo molde das irmãs.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.goto("/app/agenda");
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 20_000 });
}

/**
 * A GRADE MOSTRA A DISPONIBILIDADE DE UM TIPO — e a spec escolhe qual.
 *
 * ⚠️ Isto não é preparação de teste: é o defeito que a primeira execução achou.
 * A grade usava `tiposIniciais[0]`, o primeiro em ORDEM ALFABÉTICA, escolhido
 * por ninguém e sem seletor em lugar nenhum da tela. Nesta organização são
 * quatro tipos ativos e só o dono de "Consulta E2E" tem jornada publicada — a
 * grade inteira travou com "não consegui carregar os horários" enquanto havia
 * vaga, e o usuário não tinha como trocar.
 *
 * Escolher aqui o tipo do seed é o que dá valor às asserções seguintes: se o
 * seletor sumir da tela, esta linha falha antes de qualquer outra coisa.
 */
async function escolherOTipoDoSeed(page: Page, nome: string) {
  const seletor = page.getByTestId("tipo-da-grade");
  // Organização com um tipo só não precisa de seletor, e ele não é renderizado.
  if ((await seletor.count()) === 0) return;
  await seletor.getByRole("button", { name: new RegExp(`^${nome}$`) }).click();
}

/**
 * O primeiro bloco clicável da semana desenhada.
 *
 * A busca é por `[data-livre="true"]` e não por um horário fixo: a jornada do
 * seed é seg–sex 09:00–18:00 com uma hora de aviso mínimo, então QUAL bloco
 * está livre depende do dia e da hora em que a suíte roda. Fixar "sexta às
 * 10:00" faria a spec passar de manhã e reprovar à tarde — esta base já pagou
 * esse preço com invariante que dependia da hora.
 */
function blocoLivre(page: Page) {
  return page.locator('[data-testid^="bloco-"][data-livre="true"]').first();
}

/** Um bloco recusado que NÃO é do passado — o que tem de explicar a regra. */
function blocoBloqueado(page: Page) {
  return page
    .locator('[data-testid^="bloco-"][data-livre="false"]:not([aria-label*="já passou"])')
    .first();
}

/**
 * Leva a grade para a semana SEGUINTE e espera a disponibilidade dela responder.
 *
 * ⚠️ A NAVEGAÇÃO NÃO É CONVENIÊNCIA, é a condição de o caso existir. A grade
 * pede horários para exatamente a semana que desenha, e a semana de HOJE só
 * oferece o resto de hoje: medido com o motor real numa sexta, 16 vagas às 9h,
 * 4 às 15h, ZERO das 17h em diante — e zero o sábado inteiro, porque ali a
 * semana desenhada só tem dias úteis já passados. Foi assim que estas specs
 * derrubaram a `main` em quatro runs seguidos a partir das ~15h50.
 *
 * A razão inteira, com a tabela medida, está em `helpers/agenda-semana-integra`.
 */
async function irParaASemanaIntegra(page: Page) {
  await irParaASemanaSeguinte(page);
  await expect(
    blocoLivre(page),
    "nenhum bloco livre na semana desenhada — a rota de horários respondeu vazio, " +
      "ou a grade não está consultando a disponibilidade",
  ).toBeAttached({ timeout: 25_000 });
}

/** O `data-testid` diz o dia e a hora do bloco: `bloco-2026-08-28-09:30`. */
function horarioDoBloco(testid: string): { dia: string; hora: string } {
  const m = /^bloco-(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/.exec(testid);
  if (!m) throw new Error(`testid de bloco fora do formato esperado: ${testid}`);
  return { dia: m[1]!, hora: m[2]! };
}

// Cada caso faz login e uma jornada inteira. O teto padrão de 30s vira
// "timeout", que é indistinguível de defeito — foi o que aconteceu com a spec
// irmã na primeira execução.
test.describe.configure({ timeout: 150_000 });

test("clicar num bloco livre abre a marcação NAQUELE horário", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);
  await escolherOTipoDoSeed(page, creds.agenda!.tipo_nome);
  await irParaASemanaIntegra(page);

  const bloco = blocoLivre(page);
  // O bloco oferece o horário PUBLICADO que começa dentro dele, e o anuncia no
  // nome acessível ("Marcar às 09:30 de 28 de agosto"). É esse horário que tem
  // de reaparecer no painel — e não a hora do bloco, que pode ser outra quando
  // a organização oferece de 20 em 20 minutos.
  const rotulo = (await bloco.getAttribute("aria-label"))!;
  const oferecido = /Marcar às (\d{2}:\d{2})/.exec(rotulo)?.[1];
  expect(oferecido, `o bloco livre não anuncia o horário que vai marcar: "${rotulo}"`).toBeTruthy();

  await bloco.click();

  const painel = page.getByTestId("painel-de-marcacao");
  await expect(painel).toBeVisible({ timeout: 15_000 });
  // ⚠️ A ASSERÇÃO É O HORÁRIO, não "abriu". Um painel que abre pedindo o dia de
  // novo é exatamente o que o clique no bloco existe para evitar — e passaria
  // num teste que só checasse visibilidade.
  await expect(
    painel,
    "o painel abriu, mas não no tempo de confirmar — quem clicou num bloco já escolheu o horário",
  ).toHaveAttribute("data-tempo", "confirmando", { timeout: 10_000 });
  await expect(page.getByTestId("confirmacao")).toContainText(oferecido!);
  // A evidência é gravada DEPOIS da asserção, e não no lugar dela: imagem prova
  // o que a régua já mediu, e serve para o humano que vai revisar sem rodar.
  await page.screenshot({ path: "evidence/calendario/grade-clique-abre-no-horario.png" });
});

test("bloco fora da disponibilidade não marca — e diz por quê", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);
  await escolherOTipoDoSeed(page, creds.agenda!.tipo_nome);
  await irParaASemanaIntegra(page);

  const bloqueado = blocoBloqueado(page);
  await expect(bloqueado).toBeAttached({ timeout: 15_000 });

  // Não é clicável, e isto é do elemento — não de um `onClick` que decide não
  // fazer nada. Botão que aceita o clique e não responde é o controle
  // decorativo que esta base já pagou cinco vezes num PR só.
  await expect(bloqueado).toBeDisabled();

  // E DIZ POR QUÊ. A frase sai da mesma conta que apaga o bloco; sem ela o
  // usuário vê uma área morta e conclui que o produto quebrou.
  const razao = (await bloqueado.getAttribute("aria-label"))!;
  expect(
    razao,
    `o bloco bloqueado não explica nada: "${razao}"`,
  ).toMatch(/fora dos horários|não publicou|já há um compromisso|não consegui carregar/);
  await expect(bloqueado).toHaveAttribute("title", /.+/);

  // Clicar não abre marcação nenhuma.
  await bloqueado.click({ force: true });
  await expect(page.getByTestId("painel-de-marcacao")).toHaveCount(0);
  await page.screenshot({ path: "evidence/calendario/grade-bloco-recusado-diz-por-que.png" });
});

test("arrastar um card remarca — e o horário novo sobrevive ao reload", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);
  await escolherOTipoDoSeed(page, creds.agenda!.tipo_nome);
  await irParaASemanaIntegra(page);

  // ── o compromisso de trabalho, criado pelo caminho novo ────────────────
  const respostas: string[] = [];
  page.on("response", (r) => {
    if (!r.url().includes("/api/v1/agenda/agendamentos")) return;
    void r
      .text()
      .then((t) => respostas.push(`${r.status()} ${r.request().method()} ${t.slice(0, 300)}`))
      .catch(() => undefined);
  });

  const origem = blocoLivre(page);
  const testidOrigem = (await origem.getAttribute("data-testid"))!;
  await origem.click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("confirmar-marcacao").click();
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");

  const criado = respostas.find((r) => r.startsWith("201 POST"));
  const id = criado?.match(/"id":"([0-9a-f-]{36})"/)?.[1];
  expect(id, `o POST não devolveu id. Respostas:\n${respostas.join("\n")}`).toBeTruthy();

  const card = page.locator(`button:has([data-testid="faixa-${id}"])`);
  await expect(card).toBeVisible({ timeout: 20_000 });

  // ⚠️ O HORÁRIO QUE ACABOU DE SER MARCADO PRECISA SAIR DA OFERTA — e esperar
  // por isso é o que torna o resto do caso determinístico.
  //
  // A primeira versão pegava o alvo logo depois de ver o card, e o alvo saía
  // IGUAL à origem: a grade ainda desenhava as 11:00 como livre porque a
  // consulta de disponibilidade não tinha voltado. `useMarcarAgendamento`
  // invalida `["agenda"]`, que é prefixo da chave de `useHorariosLivres`, então
  // a repintura acontece — só não é instantânea.
  //
  // Virou asserção em vez de `waitForTimeout` porque a propriedade importa por
  // si: um horário ocupado que continua clicável leva a pessoa direto ao 422.
  await expect(
    page.locator(`[data-testid="${testidOrigem}"]`),
    "o horário recém-marcado continua sendo oferecido — a grade não reconsultou a disponibilidade",
  ).toHaveAttribute("data-livre", "false", { timeout: 20_000 });

  // ── o alvo: outro bloco livre, no mesmo dia ────────────────────────────
  const { dia } = horarioDoBloco(testidOrigem);
  // ⚠️ O ALVO É O BLOCO LIVRE MAIS PRÓXIMO, e não o último do dia.
  //
  // A primeira versão pegava `.last()` — o fim do expediente. Card e alvo
  // ficavam a nove horas de distância na régua de 48px/hora, e rolar até o alvo
  // tirava o CARD da viewport: `boundingBox()` devolvia a caixa dele fora da
  // tela, o `mouse.move` batia em lugar nenhum, e a falha lia "o gesto não está
  // sendo capturado" — que acusa o produto de um defeito que era da distância
  // escolhida pelo teste.
  //
  // O bloco de origem virou o compromisso, então o primeiro livre do dia agora
  // é o vizinho: os dois cabem na tela ao mesmo tempo, que é a condição para o
  // ponteiro atravessar de um ao outro.
  const alvo = page.locator(`[data-testid^="bloco-${dia}-"][data-livre="true"]`).first();
  await expect(alvo).toBeAttached({ timeout: 15_000 });
  const testidAlvo = (await alvo.getAttribute("data-testid"))!;
  const horarioOferecido = /Marcar às (\d{2}:\d{2})/.exec((await alvo.getAttribute("aria-label"))!)![1]!;
  expect(
    testidAlvo,
    "o alvo do arraste é o mesmo bloco de origem — a semana só tem uma vaga e o caso não prova nada",
  ).not.toBe(testidOrigem);

  await alvo.scrollIntoViewIfNeeded();
  const caixaCard = (await card.boundingBox())!;
  const caixaAlvo = (await alvo.boundingBox())!;
  // Sem os dois na tela ao mesmo tempo não há gesto de ponteiro possível — e a
  // falha diria "o arraste não funciona", que é a acusação errada.
  expect(
    caixaCard.y > 0 && caixaAlvo.y > 0,
    `card (y=${Math.round(caixaCard.y)}) e alvo (y=${Math.round(caixaAlvo.y)}) não estão ` +
      "visíveis ao mesmo tempo — o arraste não teria como acontecer nem com o produto certo",
  ).toBe(true);

  // ── o arraste, com o ponteiro de verdade ───────────────────────────────
  await page.mouse.move(caixaCard.x + caixaCard.width / 2, caixaCard.y + 4);
  await page.mouse.down();
  // Passos, e não um salto: o limiar de 4px só entra em arraste depois de um
  // `pointermove` de verdade, e um salto único não desenha o fantasma.
  await page.mouse.move(caixaAlvo.x + caixaAlvo.width / 2, caixaAlvo.y + 4, { steps: 12 });
  await expect(
    page.getByTestId("fantasma-do-arraste"),
    "arrastar não desenhou onde o card cairia — o gesto não está sendo capturado",
  ).toBeVisible();
  await page.screenshot({ path: "evidence/calendario/grade-arraste-fantasma.png" });
  await page.mouse.up();

  // ── confirmação ANTES de consumar: remarcar avisa quem está do outro lado ──
  const confirmacao = page.getByTestId("confirmar-remarcacao");
  await expect(
    confirmacao,
    "soltar remarcou sem perguntar — o cliente do outro lado recebe aviso de remarcação",
  ).toBeVisible({ timeout: 10_000 });
  await expect(confirmacao).toContainText(horarioOferecido);
  await page.screenshot({ path: "evidence/calendario/grade-confirma-antes-de-remarcar.png" });
  await page.getByTestId("confirmar-remarcacao-botao").click();

  // ── ⚠️ A PROVA NÃO É A TELA ───────────────────────────────────────────
  //
  // O card se move na hora por otimismo — estado local, antes de o servidor
  // responder. Card que se moveu visualmente e não persistiu é o pior desfecho
  // possível, porque parece que funcionou. Quem responde é a API, depois do F5.
  await expect
    .poll(
      async () => {
        const r = await page.request.get(
          `/api/v1/agenda/agendamentos?de=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}` +
            `&ate=${encodeURIComponent(new Date(Date.now() + 30 * 86_400_000).toISOString())}`,
        );
        const corpo = (await r.json()) as { data?: Array<{ id: string; iniciaEm: string }> };
        const alvoNaApi = (corpo.data ?? []).find((a) => a.id === id);
        return alvoNaApi ? new Date(alvoNaApi.iniciaEm).toTimeString().slice(0, 5) : "ausente";
      },
      { timeout: 20_000, message: "o servidor não registrou o horário novo" },
    )
    .toBe(horarioOferecido);

  await page.reload();
  await expect(page.getByTestId("tela-agenda")).toBeVisible({ timeout: 20_000 });
  // ⚠️ O F5 DESFAZ A NAVEGAÇÃO — a âncora da grade é estado do React (`useState(new
  // Date())`), então recarregar devolve a tela para a semana de HOJE. O
  // compromisso vive na semana seguinte, e sem voltar até ele a asserção abaixo
  // procura um cartão que a grade não tem por que desenhar: a falha lê "o
  // horário novo não sobreviveu ao reload", que é a acusação errada.
  //
  // Medido: sem esta linha o caso reprova com `element(s) not found` no
  // `faixa-<id>`, com o servidor tendo confirmado o horário novo dois `await`
  // acima. O que não sobrevive ao F5 é a NAVEGAÇÃO, não o dado.
  await irParaASemanaSeguinte(page);
  const cardDepois = page.locator(`button:has([data-testid="faixa-${id}"])`);
  await expect(cardDepois).toHaveAttribute("aria-label", new RegExp(`${horarioOferecido} às`), {
    timeout: 20_000,
  });

  // ── caso 5: a GEOMETRIA, medida por ferramenta ────────────────────────
  //
  // O card tem de estar na faixa de hora do horário novo. A olho isto é "parece
  // certo"; medido, é o topo do card contra o topo do bloco daquele horário.
  const blocoDoNovoHorario = page.locator(`[data-testid="bloco-${dia}-${horarioOferecido}"]`);
  await blocoDoNovoHorario.scrollIntoViewIfNeeded();
  const caixaFinal = (await cardDepois.boundingBox())!;
  const caixaFaixa = (await blocoDoNovoHorario.boundingBox())!;
  expect(
    Math.abs(caixaFinal.y - caixaFaixa.y),
    `o card foi remarcado para ${horarioOferecido} e está desenhado ${Math.round(
      caixaFinal.y - caixaFaixa.y,
    )}px fora da faixa daquela hora`,
  ).toBeLessThanOrEqual(2);

  // LIMPEZA, como as irmãs: sem isto cada corrida consome uma vaga da agenda.
  const apagou = await page.request.delete("/api/v1/agenda/agendamentos", {
    data: { id, reason: "limpeza da spec da grade interativa" },
  });
  expect(apagou.ok(), `a spec não conseguiu cancelar o que criou (${apagou.status()})`).toBe(true);
});

test("arrastar para fora da disponibilidade é RECUSADO e o card volta", async ({ page }) => {
  const creds = lerCreds();
  await entrar(page, creds);
  await escolherOTipoDoSeed(page, creds.agenda!.tipo_nome);
  await irParaASemanaIntegra(page);

  const respostas: string[] = [];
  page.on("response", (r) => {
    if (!r.url().includes("/api/v1/agenda/agendamentos")) return;
    void r
      .text()
      .then((t) => respostas.push(`${r.status()} ${r.request().method()} ${t.slice(0, 200)}`))
      .catch(() => undefined);
  });

  const origem = blocoLivre(page);
  const testidOrigem = (await origem.getAttribute("data-testid"))!;
  await origem.click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("confirmar-marcacao").click();
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");

  const id = respostas.find((r) => r.startsWith("201 POST"))?.match(/"id":"([0-9a-f-]{36})"/)?.[1];
  expect(id, `o POST não devolveu id. Respostas:\n${respostas.join("\n")}`).toBeTruthy();

  const card = page.locator(`button:has([data-testid="faixa-${id}"])`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  const rotuloAntes = (await card.getAttribute("aria-label"))!;

  /**
   * ⚠️ A POSIÇÃO DO CARD É MEDIDA CONTRA O BLOCO DA PRÓPRIA HORA, não contra a
   * viewport — e esta linha é conserto de RÉGUA, não de produto.
   *
   * A primeira versão guardava `boundingBox().y` antes do arraste e comparava
   * com o `y` depois. Entre as duas medidas há um `scrollIntoViewIfNeeded` no
   * bloco de destino, que ROLA a grade: o card não saiu do lugar e o `y` mudou
   * 42px. A asserção acusava o produto de mentir sobre o horário, e quem tinha
   * mudado de referencial era o teste.
   *
   * A distância entre o card e o bloco da sua hora não depende da rolagem.
   */
  const blocoDaHoraOriginal = page.locator(`[data-testid="${testidOrigem}"]`);
  const distanciaAoBloco = async () =>
    (await card.boundingBox())!.y - (await blocoDaHoraOriginal.boundingBox())!.y;
  const distanciaAntes = await distanciaAoBloco();

  const bloqueado = blocoBloqueado(page);
  await bloqueado.scrollIntoViewIfNeeded();
  const caixaBloqueada = (await bloqueado.boundingBox())!;
  // Depois de rolar, a caixa do card mudou de lugar na tela — o arraste tem de
  // partir de onde ele ESTÁ agora, não de onde estava antes do scroll.
  const caixaCard = (await card.boundingBox())!;

  await page.mouse.move(caixaCard.x + caixaCard.width / 2, caixaCard.y + 4);
  await page.mouse.down();
  await page.mouse.move(caixaBloqueada.x + caixaBloqueada.width / 2, caixaBloqueada.y + 4, {
    steps: 12,
  });
  // O fantasma existe e está marcado como INVÁLIDO — o gesto continua legível,
  // e a recusa é vista antes de soltar em vez de o card voltar sem explicação.
  await expect(page.getByTestId("fantasma-do-arraste")).toHaveAttribute("data-valido", "false");
  await page.mouse.up();

  // Recusa explícita, com o motivo. E NENHUMA confirmação: remarcar para um
  // horário fora da disponibilidade publicada não é uma pergunta a fazer.
  await expect(page.getByTestId("remarcacao-recusada")).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: "evidence/calendario/grade-arraste-recusado.png" });
  await expect(page.getByTestId("confirmar-remarcacao")).toHaveCount(0);

  // O CARD VOLTOU. Não basta não ter remarcado: o card tem de estar onde
  // estava, senão a tela mente sobre o estado real.
  await expect(card).toHaveAttribute("aria-label", rotuloAntes);
  expect(
    Math.abs((await distanciaAoBloco()) - distanciaAntes),
    "o arraste foi recusado e o card ficou no lugar novo — a tela está mentindo sobre o horário",
  ).toBeLessThanOrEqual(1);

  // E o servidor não foi tocado: nenhum PATCH saiu.
  expect(
    respostas.filter((r) => r.includes(" PATCH ")),
    `um destino inválido virou PATCH: ${respostas.join(" | ")}`,
  ).toHaveLength(0);

  const apagou = await page.request.delete("/api/v1/agenda/agendamentos", {
    data: { id, reason: "limpeza da spec da grade interativa" },
  });
  expect(apagou.ok(), `a spec não conseguiu cancelar o que criou (${apagou.status()})`).toBe(true);
});
