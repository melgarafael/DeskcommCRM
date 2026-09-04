/**
 * O painel de quem configura o agente — pela tela, como o dono da clínica faz.
 *
 * A pergunta que este spec responde não é "o componente renderiza", é: uma
 * pessoa que não programa consegue ligar uma jornada de trabalho, entender o que
 * ligou, e depois olhar e saber se está funcionando?
 *
 * O caso que mais importa é o terceiro: ligar "Atender e responder" NÃO pode dar
 * ao agente o direito de mandar WhatsApp para o cliente. Isso está preso em
 * teste unitário (`tests/unit/selecao-por-pacote.test.ts`), mas unitário prova a
 * função — só a tela prova que a função é a que o clique chama.
 *
 * Pré-requisitos (rodados aqui se faltarem):
 *   scripts/seed-e2e-credentials.ts · seed-e2e-followup-agent.ts · seed-e2e-capacidades.ts
 *
 * O teste devolve o estado como encontrou: o rascunho volta com a lista de
 * capacidades que tinha antes, então roda quantas vezes for preciso.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { loginComoAdmin } from "./helpers/login-admin";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
// Versionada de propósito: `.superpowers/evidence/` está no `.gitignore`, e o
// gate `tests/unit/evidencia-citada.test.ts` reprova documento que cita imagem
// que o repositório não entrega — imagem citada é lastro de afirmação.
const EVIDENCIA = path.join(process.cwd(), "evidence", "ia-360-w1");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
  admin_totp?: { secret: string };
  capacidades?: { agent_id: string; version_id: string };
}

function seed(script: string): void {
  execFileSync("npx", ["tsx", `scripts/${script}`], { stdio: "inherit" });
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) seed("seed-e2e-credentials.ts");
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager) {
    seed("seed-e2e-credentials.ts");
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  if (!c.capacidades) {
    seed("seed-e2e-followup-agent.ts");
    seed("seed-e2e-capacidades.ts");
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

let creds = loadCreds();
const AGENTE = creds.capacidades!.agent_id;

/** O que o seed deixa ligado — o cenário conhecido de onde os casos partem. */
const TOOLS_DO_SEED = ["crm_get_lead", "crm_move_lead_stage", "crm_list_leads"];

/** A capacidade que não pode entrar por pacote. */
const ENVIO = "crm_send_whatsapp_message";
/** Uma que entra: leitura pura, dentro de "Atender e responder". */
const LEITURA = "crm_get_conversation_history";

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

/**
 * Configurar exige ADMIN, não manager: `page.tsx` passa `readOnly` quando
 * `role < admin`, e o formulário inteiro (inclusive os switches de pacote)
 * nasce desabilitado. Isso é RBAC pré-existente do repo — foi a prova em tela
 * que mostrou, com o switch resolvendo para `<button disabled>`.
 * E admin tem MFA obrigatório (doutrina do repo), daí o TOTP — cuja fragilidade
 * em banco compartilhado está tratada no helper.
 */
async function entrarComoAdmin(page: Page): Promise<void> {
  creds = (await loginComoAdmin(page, creds)) as typeof creds;
}

async function abrirConfiguracao(page: Page): Promise<void> {
  await page.goto(`/app/ai/agents/${AGENTE}`);
  // A primeira renderização desta rota em `next start` leva dezenas de
  // segundos (medido: >30s no primeiro acesso, 4s nos seguintes).
  await page.getByTestId("tool-picker").waitFor({ state: "visible", timeout: 90_000 });
}

/** Marcada ou não, lido do atributo que o componente publica. */
function capacidade(page: Page, name: string) {
  return page.getByTestId(`capacidade-${name}`).first();
}

async function estaMarcada(page: Page, name: string): Promise<boolean> {
  return (await capacidade(page, name).getAttribute("data-marcada")) === "sim";
}

async function consumo(page: Page): Promise<string> {
  return (await page.getByTestId("consumo-teto").textContent()) ?? "";
}

/**
 * Salva e espera a CONFIRMAÇÃO do servidor, não um tempo.
 * O toast de sucesso traz o número da versão — é a prova de que a lista foi
 * aceita pelo Zod do servidor (que aplica o mesmo teto que a tela mostra).
 */
async function salvarRascunho(page: Page): Promise<void> {
  await page.getByRole("button", { name: /salvar rascunho/i }).click();
  await expect(page.getByText(/Rascunho v\d+ salvo/)).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(() => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
});

test.describe("Configurar o que o agente pode fazer", () => {
  // 240s e não 120s: o orçamento inclui UMA re-semeadura de credenciais, que o
  // login dispara sozinho quando outra sessão rotaciona o fator TOTP deste banco
  // compartilhado. Medido: o primeiro caso da bateria estourava 120s só nisso.
  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async ({ page }) => {
    await entrarComoAdmin(page);
  });

  test("as jornadas aparecem em português, com explicação e contagem", async ({ page }) => {
    await abrirConfiguracao(page);

    // Os 6 pacotes estão na tela, e o texto é o que uma pessoa lê — não id.
    await expect(page.getByText("Atender e responder")).toBeVisible();
    await expect(page.getByText("Vender e mover o funil")).toBeVisible();
    await expect(
      page.getByText(/O agente lê a conversa, entende o histórico/),
    ).toBeVisible();

    // Medida por ferramenta, não a olho: o card tem área real e cabe na tela.
    const caixa = await page.getByTestId("pacote-atender").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { largura: r.width, altura: r.height, esquerda: r.left, direita: r.right };
    });
    const larguraDaJanela = await page.evaluate(() => window.innerWidth);
    expect(caixa.altura).toBeGreaterThan(60);
    expect(caixa.largura).toBeGreaterThan(300);
    expect(caixa.esquerda).toBeGreaterThanOrEqual(0);
    expect(caixa.direita).toBeLessThanOrEqual(larguraDaJanela);

    // A contagem diz quantas das capacidades do pacote estão ligadas.
    //
    // ⚠️ Esta asserção JÁ COBROU `/Nenhuma capacidade disponível ainda/`, e estava
    // certa quando foi escrita: a W1 rodou com o pacote `reter` ainda VAZIO,
    // antes de a W2 entregar. O épico preencheu os seis pacotes e a frase virou
    // falsa — o teste passou a travar um estado transitório em vez de uma
    // propriedade. A tela diz "0 de 6 capacidades ligadas", que é o correto.
    //
    // O caminho "pacote vazio" não some da cobertura: ele é do COMPONENTE, e
    // vive em tests/unit/selecao-por-pacote.test.ts (função textoDaContagem) — aqui
    // não há mais como alcançá-lo sem esvaziar o catálogo, e um E2E que depende
    // de catálogo vazio não descreve nenhuma instalação real.
    await expect(page.getByTestId("contagem-reter")).toContainText(
      /\d+ de \d+ capacidades? ligadas?/,
    );

    await page
      .getByTestId("tool-picker")
      .screenshot({ path: path.join(EVIDENCIA, "w1-capacidades-por-jornada.png") });
  });

  test("ligar uma jornada NÃO dá ao agente o direito de mandar WhatsApp", async ({ page }) => {
    await abrirConfiguracao(page);

    const antes = await consumo(page);
    expect(antes).toMatch(/de 20$/);

    // Uma quarta capacidade além das 3 do seed, de fora do pacote "Atender"
    // (`crm_list_pipelines`, seguro) — só para o teste continuar montando o
    // cenário "estoura o teto por 1" à mão, em vez de depender do tamanho
    // exato do catálogo (que muda quando capacidade entra ou sai — ver
    // `lib/mcp/tools/selecao-por-pacote.ts` para a conta de verdade).
    await page.getByTestId("toggle-avancado").click();
    await page.getByTestId("lista-avancada").waitFor({ state: "visible" });
    await page.getByTestId("capacidade-crm_list_pipelines").locator("input[type=checkbox]").click();
    await page.getByTestId("toggle-avancado").click();

    // O TETO ENTRA NA JORNADA (issue #162), e entra antes do clique.
    //
    // "Atender" exige mais vagas do que o que sobrou no teto de 20 com as 4
    // capacidades já ligadas acima — a conta exata é dinâmica (depende do
    // catálogo) e vive em `vagasExigidasPeloPacote`, vigiada por
    // `tests/unit/pacote-reserva-vaga-da-critica.test.ts`; aqui só importa que
    // ESTOURA por 1.
    //
    // Antes da correção a tela aceitava o pacote, chegava ao teto exato e
    // deixava o checkbox da crítica DESABILITADO — prometia uma escolha que o
    // produto não permitia fazer, sem dizer por quê. Agora recusa e diz
    // quantas vagas faltam, e o operador faz o que a própria tela manda.
    await page.getByTestId("switch-pacote-atender").click();
    await expect(page.getByTestId("aviso-teto")).toContainText(/faltam? 1 vaga/);
    await expect(
      page.getByTestId("pacote-atender"),
      "recusar significa NÃO aplicar: pacote meio-ligado seria o pior dos dois mundos",
    ).not.toHaveAttribute("data-estado", "ligado");

    // Libera a vaga desligando uma capacidade que o seed tinha ligado.
    await page.getByTestId("toggle-avancado").click();
    await page.getByTestId("lista-avancada").waitFor({ state: "visible" });
    await page
      .getByTestId(`capacidade-${TOOLS_DO_SEED[2]}`)
      .locator("input[type=checkbox]")
      .click();
    await page.getByTestId("toggle-avancado").click();

    await page.getByTestId("switch-pacote-atender").click();

    // As capacidades da jornada entraram…
    await expect(page.getByTestId("pacote-atender")).toHaveAttribute(
      "data-estado",
      "ligado",
    );
    // …e para conferir UMA A UMA é preciso abrir o modo avançado: no caminho
    // padrão a tela mostra o pacote, não as fichas. As únicas fichas visíveis
    // fora dele são as críticas — que é exatamente o ponto do desenho.
    await page.getByTestId("toggle-avancado").click();
    await page.getByTestId("lista-avancada").waitFor({ state: "visible" });
    await expect.poll(() => estaMarcada(page, LEITURA), { timeout: 5_000 }).toBe(true);

    // …e a que fala com o cliente de verdade, não.
    expect(await estaMarcada(page, ENVIO)).toBe(false);

    // Ela aparece separada, pedindo a marcação individual.
    const bloco = page.getByTestId("criticas-atender");
    await expect(bloco).toBeVisible();
    await expect(bloco).toContainText(/o pacote não liga por você/i);
    await expect(bloco).toContainText("Enviar mensagem no WhatsApp");

    expect(await consumo(page)).not.toBe(antes);
    await page
      .getByTestId("tool-picker")
      .screenshot({ path: path.join(EVIDENCIA, "w1-pacote-ligado-sem-envio.png") });

    // Marcar à mão funciona — o humano pode, o pacote não.
    await page
      .getByTestId("criticas-atender")
      .getByTestId(`capacidade-${ENVIO}`)
      .locator("input[type=checkbox]")
      .click();
    await expect.poll(() => estaMarcada(page, ENVIO), { timeout: 5_000 }).toBe(true);

    // E desligar a jornada leva a crítica junto: declarar que a jornada acabou
    // e ficar com o direito de enviar mensagem seria a pior surpresa possível.
    await page.getByTestId("switch-pacote-atender").click();
    await expect.poll(() => estaMarcada(page, ENVIO), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => estaMarcada(page, LEITURA), { timeout: 5_000 }).toBe(false);
  });

  test("o modo avançado revela a ficha e o nome técnico", async ({ page }) => {
    await abrirConfiguracao(page);

    // Antes de abrir, o nome técnico não está na tela do leigo.
    await expect(page.getByTestId("lista-avancada")).toHaveCount(0);

    await page.getByTestId("toggle-avancado").click();
    const lista = page.getByTestId("lista-avancada");
    await expect(lista).toBeVisible();
    await expect(lista).toContainText(ENVIO);
    await expect(lista).toContainText("Enviar mensagem no WhatsApp");
    await expect(lista).toContainText("Efeito que não dá para desfazer");

    const alturaDaLista = await lista.evaluate((el) => el.getBoundingClientRect().height);
    expect(alturaDaLista).toBeGreaterThan(200);

    await lista.screenshot({ path: path.join(EVIDENCIA, "w1-modo-avancado.png") });
  });

  test("a escolha sobrevive ao salvar e recarregar", async ({ page }) => {
    await abrirConfiguracao(page);

    // Espera a configuração CARREGAR. Ler o estado antes disso devolve lista
    // vazia, e um teste que compara vazio com vazio passa sem medir nada.
    await expect(page.getByTestId("consumo-teto")).toHaveText(
      `${TOOLS_DO_SEED.length} de 20`,
    );

    await page.getByTestId("switch-pacote-vender").click();
    await expect(page.getByTestId("pacote-vender")).toHaveAttribute("data-estado", "ligado");
    const consumoDepoisDeLigar = await consumo(page);

    await salvarRascunho(page);

    await page.reload();
    await page.getByTestId("tool-picker").waitFor({ state: "visible" });
    await expect(page.getByTestId("pacote-vender")).toHaveAttribute("data-estado", "ligado");
    expect(await consumo(page)).toBe(consumoDepoisDeLigar);

    // Devolve o estado como encontrou — pelo seed, não pela UI. Desligar
    // "Vender e mover o funil" levaria junto as três capacidades que já
    // estavam ligadas (todas pertencem a essa jornada), e o teste deixaria o
    // cenário do próximo diferente do que ele espera.
    seed("seed-e2e-capacidades.ts");
    await page.reload();
    await page.getByTestId("tool-picker").waitFor({ state: "visible" });
    await expect(page.getByTestId("consumo-teto")).toHaveText(
      `${TOOLS_DO_SEED.length} de 20`,
    );
  });
});

test.describe("Olhar o agente funcionando", () => {
  // 240s e não 120s: o orçamento inclui UMA re-semeadura de credenciais, que o
  // login dispara sozinho quando outra sessão rotaciona o fator TOTP deste banco
  // compartilhado. Medido: o primeiro caso da bateria estourava 120s só nisso.
  test.describe.configure({ timeout: 240_000 });

  // De propósito como MANAGER: olhar o agente funcionando é atividade de quem
  // opera, e a rota `/tool-usage` foi escrita com essa régua. Se a leitura
  // dependesse de admin, o manager veria "0 usos" — indistinguível de "nunca
  // usada", que é a pior mentira que esta tela poderia contar.
  test("o painel mostra o uso real, e o que fazer com cada número", async ({ page }) => {
    await login(page, creds.users.manager!.email);
    await page.goto(`/app/ai/agents/${AGENTE}`);
    await page.getByRole("tab", { name: /capacidades/i }).click();

    const painel = page.getByTestId("uso-das-capacidades");
    await painel.waitFor({ state: "visible" });

    // Os números vêm do que o emissor real (`auditMcpToolCall`) escreveu no
    // seed: 3 usos de "Ver uma oportunidade" sem falha, 2 de "Mover" — as duas
    // falharam — e 1 busca de cliente, essa só em execução de teste.
    await expect(page.getByTestId("uso-total")).toHaveText("6");
    await expect(page.getByTestId("uso-falhas")).toHaveText("2");

    // Ligada e falhando em toda tentativa: o que mais pede decisão.
    const moveu = page.getByTestId("uso-crm_move_lead_stage");
    await expect(moveu).toHaveAttribute("data-sinal", "so_falha");
    await expect(moveu).toContainText(/Todas as 2 tentativas falharam/);

    // Ligada, usada, sem falha.
    const leu = page.getByTestId("uso-crm_get_lead");
    await expect(leu).toHaveAttribute("data-sinal", "saudavel");
    await expect(leu).toContainText("3");

    // Ligada e nunca usada: ocupa vaga e concorre na escolha do agente.
    const nunca = page.getByTestId("uso-crm_list_leads");
    await expect(nunca).toHaveAttribute("data-sinal", "nunca_usada");
    await expect(nunca).toContainText(/nunca usada nos últimos 30 dias/);

    // Usada SEM estar na configuração — e o texto não afirma a causa.
    const buscou = page.getByTestId("uso-crm_search_contacts");
    await expect(buscou).toHaveAttribute("data-sinal", "fora_da_configuracao");
    await expect(buscou).toContainText(/sem ela estar ligada nesta configuração/);
    await expect(buscou).toContainText("desligada");

    // O que pede ação vem primeiro — a ordem é informação, não estética.
    const sinais = await painel.evaluate((el) =>
      [...el.querySelectorAll("[data-sinal]")].map((n) => n.getAttribute("data-sinal")),
    );
    expect(sinais[0]).toBe("so_falha");
    expect(sinais.indexOf("saudavel")).toBe(sinais.length - 1);

    await painel.screenshot({ path: path.join(EVIDENCIA, "w1-uso-das-capacidades.png") });
  });
});
