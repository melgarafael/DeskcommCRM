/**
 * RETOMAR AO DEVOLVER — provado PELA TELA.
 *
 * O defeito: a pessoa da equipe manda o orçamento, clica em "Devolver ao
 * automático" e o agente só voltava a falar quando o CLIENTE escrevesse de
 * novo. A opção nova do agente ("Continuar a conversa assim que a equipe
 * devolver ao automático") faz a devolução pôr UM turno de retomada na fila.
 *
 * O que esta spec dirige pela tela, como um dono faria:
 *  1. a opção aparece DESLIGADA no editor do agente, e ligá-la SOBREVIVE ao
 *     salvar e recarregar (o schema `.strict()` da versão descartaria a chave
 *     se a validação não a conhecesse: a caixa voltaria desligada com o salvar
 *     "verde");
 *  2. com o agente publicado e a última fala da conversa sendo da equipe, o
 *     botão "Devolver ao automático" põe na fila UM `followup_turn` com
 *     `mode='retomada'`, ligado ao `ai.handoff_resolved` daquela devolução;
 *  3. controle: com o CLIENTE por último, a mesma devolução NÃO põe nada.
 *
 * ⚠️ O QUE É REAL AQUI. O consumidor (`lib/escalacao/retomada-ao-devolver.ts`)
 * é event-driven: a rota emite `ai.handoff_resolved` e o dreno do `event_log`
 * consome. Em produção quem drena é o laço do worker (e o cron de rede de
 * segurança); a spec chama a MESMA rota de cron (`/api/v1/cron/event-log-drain`)
 * com o segredo interno, como `gatilho-de-etapa.spec.ts`.
 *
 * ⚠️ O QUE NÃO É PROVADO AQUI. O turno do agente em si (modelo + WhatsApp) não
 * roda no e2e: não há worker do agente nem canal real. A reconferência do
 * worker e a abertura do turno estão em
 * `tests/unit/retomada-ao-devolver-no-turno.test.ts`.
 *
 * ⚠️ O QUE É SETUP. Criar o agente pela API, publicá-lo e semear a conversa com
 * as três travas da passagem ligadas é o cenário, não a feature — cada um tem
 * spec própria.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { esperarARevelacaoNasCargas, test, expect, type Browser, type Page } from "./helpers/test";
import { loginComoAdmin, lerCreds, type CredsE2E } from "./helpers/login-admin";
import { carregarEnvLocal, credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const EVIDENCIA = path.join(process.cwd(), "evidence", "retomar-ao-devolver");
fs.mkdirSync(EVIDENCIA, { recursive: true });

const ESPERA = 60_000;

const supa = credenciaisSupabaseDeTeste();
const db = createClient(supa.url, supa.serviceRole, { auth: { persistSession: false } });

type CredsComFixtures = CredsE2E & {
  org_id?: string;
  followup_agent_fixtures?: { credential_id: string; channel_session_id: string };
};

let creds = lerCreds() as CredsComFixtures;
let pagina: Page;
let agentId = "";
let adminId = "";
const marca = randomUUID().slice(0, 8);
const criados = { contatos: [] as string[], conversas: [] as string[] };

test.use({ locale: "pt-BR" });
test.describe.configure({ timeout: 240_000, mode: "serial" });

function segredoInterno(): string {
  const secret = carregarEnvLocal().INTERNAL_SECRET?.trim();
  if (!secret) throw new Error("INTERNAL_SECRET não encontrado em .env.local");
  return secret;
}

function org(): string {
  if (!creds.org_id) throw new Error("`.e2e-creds.json` sem `org_id` — rode scripts/seed-e2e-credentials.ts");
  return creds.org_id;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  if (!creds.followup_agent_fixtures) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-followup-agent.ts"], { stdio: "inherit" });
  }
  // Publicar exige credencial validada e sessão WORKING — explícito aqui, não herdado.
  execFileSync("npx", ["tsx", "scripts/e2e-followup-journey-helpers.ts", "prepare-agent-fixtures"], {
    stdio: "inherit",
  });
  creds = lerCreds() as CredsComFixtures;

  const contexto = await browser.newContext({ locale: "pt-BR" });
  contexto.on("page", esperarARevelacaoNasCargas);
  pagina = await contexto.newPage();
  creds = (await loginComoAdmin(pagina, creds)) as CredsComFixtures;

  const { data: lista, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const admin = lista.users.find((u) => u.email === creds.users.admin!.email);
  if (!admin) throw new Error("admin do e2e não encontrado no auth");
  adminId = admin.id;

  const fixtures = creds.followup_agent_fixtures!;
  const cria = await pagina.request.post("/api/v1/ai/agents", {
    data: {
      name: `E2E Retomar ao devolver ${marca}`,
      version: {
        system_prompt: "Agente de teste E2E da retomada ao devolver ao automático.",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        credential_id: fixtures.credential_id,
        channel_session_id: fixtures.channel_session_id,
      },
    },
  });
  expect(cria.status(), await cria.text()).toBe(201);
  agentId = ((await cria.json()) as { data: { agent: { id: string } } }).data.agent.id;
});

test.afterAll(async () => {
  if (criados.conversas.length > 0) {
    await db.from("job_queue").delete().eq("organization_id", org()).in("payload->>conversation_id", criados.conversas);
    await db.from("messages").delete().eq("organization_id", org()).in("conversation_id", criados.conversas);
    await db.from("conversations").delete().eq("organization_id", org()).in("id", criados.conversas);
  }
  if (criados.contatos.length > 0) await db.from("contacts").delete().eq("organization_id", org()).in("id", criados.contatos);
  if (agentId) await pagina.request.delete(`/api/v1/ai/agents/${agentId}`).catch(() => undefined);
  await pagina?.context().close();
});

const interruptor = () => pagina.getByRole("switch", { name: "Continuar a conversa assim que a equipe devolver ao automático" });

async function abrirAgente(): Promise<void> {
  await pagina.goto(`/app/ai/agents/${agentId}`);
  await expect(pagina.getByText("Quando ele entra em ação")).toBeVisible({ timeout: ESPERA });
  await interruptor().scrollIntoViewIfNeeded();
}

async function fotografarOpcao(nome: string): Promise<void> {
  const caixa = await interruptor().locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]").boundingBox();
  if (caixa === null) throw new Error("opção sem caixa medida");
  const rolagem = await pagina.evaluate(() => window.scrollY);
  await pagina.screenshot({
    path: path.join(EVIDENCIA, nome),
    fullPage: true,
    clip: { x: Math.max(0, caixa.x - 16), y: Math.max(0, caixa.y + rolagem - 16), width: caixa.width + 32, height: caixa.height + 32 },
  });
}

/** Uma conversa com as três travas da passagem ligadas e as mensagens na ordem dada. */
async function conversaComPassagem(mensagens: Array<{ direction: "inbound" | "outbound"; sent_via: string | null; body: string }>): Promise<string> {
  const fixtures = creds.followup_agent_fixtures!;
  const contato = await db.from("contacts").insert({
    organization_id: org(),
    display_name: `Cliente Retomada ${marca} ${criados.contatos.length}`,
    phone_number: `+5511977${String(Date.now()).slice(-6)}${criados.contatos.length}`,
    force_human: true,
  }).select("id").single();
  expect(contato.error).toBeNull();
  criados.contatos.push(contato.data!.id);
  const conversa = await db.from("conversations").insert({
    organization_id: org(),
    contact_id: contato.data!.id,
    channel_session_id: fixtures.channel_session_id,
    status: "claimed",
    assigned_to_user_id: adminId,
    assignee_kind: "user",
    bot_silenced_until: "infinity",
    active_ai_agent_id: agentId,
  }).select("id").single();
  expect(conversa.error).toBeNull();
  const conversationId = conversa.data!.id as string;
  criados.conversas.push(conversationId);
  const base = Date.now() - mensagens.length * 60_000;
  for (const [i, m] of mensagens.entries()) {
    const r = await db.from("messages").insert({
      organization_id: org(),
      conversation_id: conversationId,
      channel_session_id: fixtures.channel_session_id,
      contact_id: contato.data!.id,
      direction: m.direction,
      type: "text",
      body: m.body,
      status: m.direction === "inbound" ? "received" : "sent",
      // Inbound não tem `sent_via` (a coluna é NOT NULL com default): o seed não inventa um.
      ...(m.sent_via !== null ? { sent_via: m.sent_via } : {}),
      sent_by_user_id: m.direction === "outbound" ? adminId : null,
      sent_at: new Date(base + i * 60_000).toISOString(),
    });
    expect(r.error, r.error?.message).toBeNull();
  }
  return conversationId;
}

async function devolverPelaTela(conversationId: string, foto: string): Promise<void> {
  await pagina.goto(`/app/inbox/${conversationId}`);
  const botao = pagina.getByTestId("devolver-ao-automatico");
  await expect(botao).toBeVisible({ timeout: ESPERA });
  const resposta = pagina.waitForResponse(
    (r) => r.url().endsWith(`/conversations/${conversationId}/reactivate-bot`) && r.request().method() === "POST",
  );
  await botao.click();
  expect((await resposta).status()).toBe(200);
  // A foto só depois de a TELA dizer que o automático voltou: o 200 chega antes
  // do re-render, e a captura mostrava o botão de devolver ainda no cabeçalho.
  await expect(botao, "o cabeçalho ainda oferece devolver depois da devolução").toBeHidden({ timeout: ESPERA });
  await pagina.screenshot({ path: path.join(EVIDENCIA, foto), fullPage: true });
}

/** O dreno de produção, acionado à mão. Nenhum handler pode ter falhado. */
async function drenar(): Promise<void> {
  const r = await pagina.request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${segredoInterno()}` },
  });
  expect(r.status(), "o dreno tem que responder 200").toBe(200);
  const resumo = ((await r.json()) as { data: { failed: number; dead: number } }).data;
  expect(resumo.failed + resumo.dead, "nenhum handler pode ter falhado no dreno").toBe(0);
}

async function eventoDaDevolucao(conversationId: string): Promise<{ id: string; consumed_by: string[] } | null> {
  const r = await db.from("event_log").select("id, consumed_by")
    .eq("organization_id", org()).eq("event_type", "ai.handoff_resolved").eq("entity_id", conversationId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  expect(r.error).toBeNull();
  return (r.data as { id: string; consumed_by: string[] } | null) ?? null;
}

async function turnosDeRetomada(conversationId: string) {
  const r = await db.from("job_queue").select("id, kind, status, source_event_id, payload")
    .eq("organization_id", org()).eq("kind", "followup_turn").eq("payload->>conversation_id", conversationId);
  expect(r.error).toBeNull();
  return (r.data ?? []) as Array<{ id: string; kind: string; status: string; source_event_id: string | null; payload: Record<string, unknown> }>;
}

test.describe("retomar ao devolver ao automático", () => {
  test("a opção aparece desligada e ligá-la SOBREVIVE ao salvar e recarregar", async () => {
    await abrirAgente();
    await expect(interruptor(), "a opção tem que nascer desligada").not.toBeChecked();
    await expect(pagina.getByText(/o agente continua dali na hora, sem esperar o cliente escrever/)).toBeVisible();
    await fotografarOpcao("01-opcao-desligada.png");

    await interruptor().click();
    await expect(interruptor()).toBeChecked();
    await pagina.getByRole("button", { name: /salvar rascunho/i }).first().click();
    await expect(pagina.getByText(/rascunho v\d+ salvo/i)).toBeVisible({ timeout: 30_000 });

    // RECARREGAR é o ponto do teste.
    await abrirAgente();
    await expect(interruptor(), "a opção não sobreviveu ao reload").toBeChecked({ timeout: 20_000 });
    await fotografarOpcao("02-opcao-ligada-apos-recarregar.png");

    // E o que a tela mostra é o que ficou gravado.
    const rascunho = await db.from("ai_agent_versions").select("id, trigger_config")
      .eq("organization_id", org()).eq("agent_id", agentId).eq("status", "draft")
      .order("created_at", { ascending: false }).limit(1).single();
    expect(rascunho.error).toBeNull();
    expect((rascunho.data!.trigger_config as { resume_on_handback?: unknown }).resume_on_handback).toBe(true);

    // Publicar é setup do caso seguinte (tem spec própria).
    const publica = await pagina.request.post(`/api/v1/ai/agents/${agentId}/publish`, {
      data: { version_id: rascunho.data!.id },
    });
    expect(publica.status(), await publica.text()).toBe(200);
  });

  test("com a última fala da equipe, Devolver ao automático põe UM turno de retomada na fila", async () => {
    const conversa = await conversaComPassagem([
      { direction: "inbound", sent_via: null, body: "quero falar com um atendente" },
      { direction: "outbound", sent_via: "crm", body: `Segue o orçamento ${marca}: R$ 4.800 com instalação.` },
    ]);
    expect(await turnosDeRetomada(conversa), "controle: a fila nasce vazia para a conversa").toHaveLength(0);

    await devolverPelaTela(conversa, "03-devolvido-com-a-equipe-por-ultimo.png");
    const evento = await eventoDaDevolucao(conversa);
    expect(evento, "a devolução não emitiu ai.handoff_resolved").not.toBeNull();

    await expect.poll(async () => {
      await drenar();
      return (await turnosDeRetomada(conversa)).length;
    }, { timeout: ESPERA, intervals: [1_000, 2_000, 5_000] }).toBe(1);

    const [turno] = await turnosDeRetomada(conversa);
    expect(turno!.status).toBe("pending");
    expect(turno!.source_event_id, "o turno não está ligado ao evento desta devolução").toBe(evento!.id);
    expect(turno!.payload).toMatchObject({
      mode: "retomada",
      conversation_id: conversa,
      channel_session_id: creds.followup_agent_fixtures!.channel_session_id,
    });
    expect((turno!.payload.service_boundary as { conversation_id?: string }).conversation_id).toBe(conversa);
    expect((await eventoDaDevolucao(conversa))!.consumed_by).toContain("retomada-ao-devolver.v1");

    // Drenar de novo não duplica: o mesmo evento não vira um segundo turno.
    await drenar();
    expect(await turnosDeRetomada(conversa)).toHaveLength(1);
  });

  test("controle: com o cliente por último, a mesma devolução NÃO põe turno de retomada", async () => {
    const conversa = await conversaComPassagem([
      { direction: "outbound", sent_via: "crm", body: `Segue o orçamento ${marca}.` },
      { direction: "inbound", sent_via: null, body: "recebi, vou ver com meu marido" },
    ]);
    await devolverPelaTela(conversa, "04-devolvido-com-o-cliente-por-ultimo.png");
    expect(await eventoDaDevolucao(conversa), "a devolução não emitiu ai.handoff_resolved").not.toBeNull();

    // Dreno até o consumidor TER lido este evento — só então a ausência prova algo.
    await expect.poll(async () => {
      await drenar();
      return (await eventoDaDevolucao(conversa))?.consumed_by ?? [];
    }, { timeout: ESPERA, intervals: [1_000, 2_000, 5_000] }).toContain("retomada-ao-devolver.v1");
    expect(await turnosDeRetomada(conversa), "a retomada falou por cima do cliente").toHaveLength(0);
    // E o PORQUÊ fica gravado no próprio evento — a ausência tem motivo legível.
    const motivo = await db.from("event_log").select("last_error")
      .eq("organization_id", org()).eq("id", (await eventoDaDevolucao(conversa))!.id).single();
    expect(motivo.error).toBeNull();
    expect(motivo.data!.last_error).toContain("retomada-ao-devolver.v1: pulado:ultima_fala_nao_e_da_equipe");
  });
});
