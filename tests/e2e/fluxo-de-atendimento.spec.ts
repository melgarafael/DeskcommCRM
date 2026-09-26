/**
 * OS ROTEIROS DE ATENDIMENTO, PELA TELA (PR 3 do port do #1130, de @vgamkt).
 *
 * A jornada de quem opera uma instalação e liga o módulo:
 *   1. o DONO DO SERVIDOR liga "Fluxos de atendimento" em /admin/sistema;
 *   2. um GERENTE abre IA › Fluxos de atendimento, cria um roteiro pela tela
 *      (palavra-gatilho no Início, uma Pergunta de CPF e uma de lista, o Fim)
 *      e publica — e a paleta oferece SÓ as quatro caixas do roteiro;
 *   3. o cliente escreve pelo WEBHOOK do WhatsApp (o caminho de produção);
 *   4. as respostas aparecem na FICHA do contato.
 *
 * ⚠️ O que NÃO é o caminho de produção, e por quê: o job do CI não sobe o
 * worker nem tem chave de modelo. O turno do agente é reproduzido aqui chamando
 * as MESMAS funções que ele chama — `prepararRoteiroDoTurno` antes do modelo e
 * `garantirPerguntaDoRoteiro` depois do envio —, com o banco real e a chave real
 * do módulo. O validador (chamada de modelo) devolve `indefinido`, como devolve
 * numa instalação sem modelo: o que grava é a captura determinística (CPF com
 * dígito, opção de lista), que é código de produção.
 *
 * O módulo é da INSTALAÇÃO e o banco do e2e é compartilhado: o `afterAll`
 * desliga, para as specs seguintes verem a instalação como a encontraram.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "./helpers/test";
import pg from "pg";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { garantirPerguntaDoRoteiro, prepararRoteiroDoTurno } from "../../lib/agent-engine/agent/roteiro-no-turno";
import { moduloLigado } from "../../lib/instalacao/modulos";
import { lerCreds, loginComoDono } from "./helpers/login-admin";
import { zoomAte } from "./utils/canvas-do-fluxo";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface CredsDoNascimento {
  password: string;
  users: Record<string, { email: string }>;
  nascimento?: { webhook_token: string; session_name: string };
}

function credsComWebhook(): CredsDoNascimento {
  lerCreds();
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsDoNascimento;
  if (!c.nascimento?.webhook_token) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-nascimento-do-lead.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as CredsDoNascimento;
  }
  return c;
}

const EVIDENCIA = path.join(process.cwd(), "evidence", "fluxo-de-atendimento");
function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  return path.join(EVIDENCIA, nome);
}

const sufixo = randomUUID().slice(0, 6);
const NOME_DO_ROTEIRO = `Cadastro E2E ${sufixo}`;
const GATILHO = `financiar${sufixo}`;
// Telefone novo a cada rodada: contato que já respondeu não é perguntado de novo.
const TELEFONE = `55318${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;

test.use({ viewport: { width: 1600, height: 900 } });
test.describe.configure({ timeout: 300_000 });

test.afterAll(async () => {
  // A instalação volta a ter o módulo DESLIGADO, como o padrão.
  await db.from("platform_config").delete().eq("chave", "MODULO_FLUXOS_DE_ATENDIMENTO");
});

async function loginGerente(page: Page, creds: CredsDoNascimento): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

async function conectar(page: Page, origem: string, destino: string): Promise<void> {
  const fonte = page.locator(`.react-flow__node[data-id="${origem}"] .react-flow__handle.source`).first();
  const alvo = page.locator(`.react-flow__node[data-id="${destino}"] .react-flow__handle.target`);
  const a = await fonte.boundingBox();
  const b = await alvo.boundingBox();
  if (!a || !b) throw new Error(`bolinha não encontrada: ${origem} -> ${destino}`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 5, a.y + a.height / 2 + 5, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

async function idDoNo(page: Page, tipo: string, indice = 0): Promise<string> {
  const id = await page.locator(`.react-flow__node[data-id^="${tipo}-"]`).nth(indice).getAttribute("data-id");
  if (!id) throw new Error(`nó ${tipo} #${indice} não encontrado`);
  return id;
}

async function configurarPergunta(
  page: Page,
  id: string,
  campo: { pergunta: string; chave: string; tipo: string; opcoes?: string },
): Promise<void> {
  await page.locator(`.react-flow__node[data-id="${id}"]`).click();
  const painel = page.getByTestId("node-config-panel");
  await painel.locator("#collect-label").fill(campo.pergunta);
  await painel.locator("#collect-key").fill(campo.chave);
  await painel.locator("#collect-type").click();
  await page.getByRole("option", { name: campo.tipo }).click();
  if (campo.opcoes !== undefined) await painel.locator("#collect-options").fill(campo.opcoes);
}

/** Uma mensagem de texto, como o WAHA a entrega — a mesma rota de produção. */
async function mensagemDoCliente(page: Page, creds: CredsDoNascimento, texto: string): Promise<string> {
  const externalId = `e2e-roteiro-${randomUUID()}`;
  const r = await page.request.post(`/api/v1/webhooks/waha/${creds.nascimento!.webhook_token}`, {
    data: {
      event: "message",
      session: creds.nascimento!.session_name,
      payload: {
        id: externalId,
        from: `${TELEFONE}@c.us`,
        fromMe: false,
        body: texto,
        timestamp: Math.floor(Date.now() / 1000),
        _data: { notifyName: `Cliente Roteiro ${sufixo}` },
      },
    },
  });
  expect(r.status(), "o webhook precisa ACEITAR a mensagem").toBe(200);
  return externalId;
}

/**
 * O turno do agente para a última mensagem do cliente — as funções de produção,
 * sem o modelo. Devolve o contato que o webhook resolveu para o telefone.
 */
async function turnoDoAgente(pool: pg.Pool, externalId: string): Promise<string> {
  const { data: msg, error } = await db
    .from("messages")
    .select("id, organization_id, conversation_id, contact_id, body")
    .eq("external_id", externalId)
    .single();
  if (error || !msg) throw new Error(`mensagem não gravada pelo webhook: ${error?.message ?? "ausente"}`);
  const texto = msg.body as string;
  // O motor engole erro do roteiro para o turno seguir; aqui ele precisa
  // aparecer no log do CI, senão a falha vira só "custom_fields vazio".
  const log = { info: () => {}, debug: () => {}, warn: console.warn, error: console.error };
  const roteiro = await prepararRoteiroDoTurno(
    {
      pool,
      moduloLigado: () => moduloLigado(db, "fluxos_atendimento"),
      validar: async () => ({ resultado: "indefinido" as const }),
      log: log as never,
    },
    {
      organizationId: msg.organization_id as string,
      contactId: msg.contact_id as string,
      conversationId: msg.conversation_id as string,
      texto,
      messageId: msg.id as string,
      flowPointerDoRoteador: null,
      mensagens: [{ de: "cliente", texto }],
    },
  );
  if (roteiro !== null) {
    // O modelo não fez a pergunta (não há modelo): o motor a "envia" — é o que
    // a torna a pergunta atual no turno seguinte.
    await garantirPerguntaDoRoteiro(
      { pool, log: log as never },
      { organizationId: msg.organization_id as string, roteiro, corposEnviados: [], enviar: async () => true },
    );
  }
  return msg.contact_id as string;
}

test("liga o módulo, cria um roteiro pela tela, o cliente responde pelo WhatsApp e a ficha mostra", async ({
  page,
}) => {
  const creds = credsComWebhook();
  const pool = new pg.Pool({ connectionString: credenciais.dbUrl, max: 2 });

  try {
    await test.step("o dono do servidor liga o módulo em /admin/sistema", async () => {
      await loginComoDono(page, lerCreds());
      await page.goto("/admin/sistema");
      const chave = page.getByRole("switch", { name: "Fluxos de atendimento" });
      await expect(chave).toBeVisible();
      if ((await chave.getAttribute("aria-checked")) !== "true") await chave.click();
      await expect(chave).toHaveAttribute("aria-checked", "true");
      await expect
        .poll(async () => moduloLigado(db, "fluxos_atendimento"), { timeout: 15_000 })
        .toBe(true);
      await page.screenshot({ path: evidencia("01-modulo-ligado.png"), fullPage: true });
    });

    await test.step("o gerente cria e publica o roteiro pela tela", async () => {
      await loginGerente(page, creds);
      await page.goto("/app/ai/atendimento");
      await expect(page.getByRole("heading", { name: "Fluxos de atendimento", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Novo fluxo de atendimento" }).first().click();
      const dialogo = page.getByRole("dialog");
      await dialogo.getByLabel("Nome").fill(NOME_DO_ROTEIRO);
      await dialogo.getByRole("button", { name: "Criar fluxo" }).click();
      await expect(dialogo).not.toBeVisible();
      await page.locator("li", { hasText: NOME_DO_ROTEIRO }).getByRole("link").click();
      await page.waitForURL(/\/app\/ai\/atendimento\/[0-9a-f-]+$/);
      await expect(page.locator(".react-flow")).toBeVisible();

      // A paleta do roteiro: quatro caixas, medidas no DOM — nenhuma do relógio.
      const paleta = page.getByTestId("node-palette").locator('[data-testid^="palette-add-"]');
      await expect(paleta).toHaveCount(4);
      expect(
        await paleta.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid"))),
      ).toEqual(["palette-add-trigger", "palette-add-collect", "palette-add-skill", "palette-add-end"]);

      await page.getByTestId("palette-add-trigger").click();
      await page.getByTestId("palette-add-collect").click();
      await page.getByTestId("palette-add-collect").click();
      await page.getByTestId("palette-add-end").click();
      await zoomAte(page, 0.85);

      const inicio = await idDoNo(page, "trigger");
      const cpf = await idDoNo(page, "collect", 0);
      const modelo = await idDoNo(page, "collect", 1);
      const fim = await idDoNo(page, "end");

      await page.locator(`.react-flow__node[data-id="${inicio}"]`).click();
      await page.getByTestId("configuracoes-do-roteiro").locator("#roteiro-gatilhos").fill(GATILHO);

      await configurarPergunta(page, cpf, { pergunta: "Qual é o seu CPF?", chave: "cpf", tipo: "CPF (confere o dígito)" });
      await configurarPergunta(page, modelo, {
        pergunta: "Qual modelo te interessa?",
        chave: "modelo_interesse",
        tipo: "Escolha numa lista",
        opcoes: "CG 160, XRE 300",
      });

      // Fecha o painel antes de ligar as caixas, como faz a jornada do follow-up.
      await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
      await expect(page.getByTestId("node-config-sheet")).toHaveCount(0);
      await conectar(page, inicio, cpf);
      await conectar(page, cpf, modelo);
      await conectar(page, modelo, fim);
      await expect(page.locator(".react-flow__edge")).toHaveCount(3);

      // Publicar salva o rascunho antes (PublishBar.onPublish).
      await page.getByTestId("publish-button").click();
      await expect(page.getByText("Fluxo publicado.")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('[aria-label="status: Ativo"]')).toBeVisible();
      await page.screenshot({ path: evidencia("02-roteiro-publicado.png"), fullPage: true });

      // O que foi salvo pela tela é o que o motor vai ler: gatilho e perguntas.
      const { data: ponteiro } = await db
        .from("followup_flow_pointers")
        .select("surface, status, active_version_id")
        .eq("name", NOME_DO_ROTEIRO)
        .single();
      expect(ponteiro?.surface).toBe("atendimento");
      expect(ponteiro?.status).toBe("active");
      const { data: versao } = await db
        .from("followup_flow_versions")
        .select("graph")
        .eq("id", ponteiro!.active_version_id as string)
        .single();
      expect(JSON.stringify(versao?.graph)).toContain(GATILHO);
    });

    let contatoId = "";
    await test.step("o cliente escreve pelo WhatsApp e o roteiro coleta", async () => {
      contatoId = await turnoDoAgente(pool, await mensagemDoCliente(page, creds, `oi, quero ${GATILHO} uma moto`));
      await turnoDoAgente(pool, await mensagemDoCliente(page, creds, "meu cpf é 529.982.247-25"));
      await turnoDoAgente(pool, await mensagemDoCliente(page, creds, "quero a XRE 300"));
    });

    await test.step("a ficha do contato mostra o que o roteiro coletou", async () => {
      const { data: contato } = await db.from("contacts").select("id, custom_fields").eq("id", contatoId).single();
      expect(contato?.custom_fields).toMatchObject({ cpf: "52998224725", modelo_interesse: "XRE 300" });

      await page.goto(`/app/contacts/${contato!.id}`);
      const cartao = page.getByTestId("roteiros-do-contato");
      await expect(cartao).toBeVisible({ timeout: 20_000 });
      await expect(cartao.getByText(NOME_DO_ROTEIRO)).toBeVisible();
      await expect(cartao.getByText("Concluído")).toBeVisible();
      await expect(page.getByTestId("roteiro-campo-cpf")).toContainText("52998224725");
      await expect(page.getByTestId("roteiro-campo-modelo_interesse")).toContainText("XRE 300");

      // Medido por ferramenta: o cartão ocupa espaço de verdade na tela e está
      // visível pelo estilo computado (não só presente no DOM).
      const caixa = await cartao.boundingBox();
      expect(caixa?.width ?? 0).toBeGreaterThan(200);
      expect(caixa?.height ?? 0).toBeGreaterThan(60);
      expect(
        await cartao.evaluate((el) => {
          const s = getComputedStyle(el);
          return s.visibility === "visible" && s.display !== "none" && Number(s.opacity) > 0;
        }),
      ).toBe(true);
      await page.screenshot({ path: evidencia("03-ficha-do-contato.png"), fullPage: true });
    });
  } finally {
    await pool.end();
  }
});
