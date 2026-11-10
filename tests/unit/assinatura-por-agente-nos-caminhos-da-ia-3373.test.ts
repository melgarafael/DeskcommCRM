/**
 * #3373 — o NOME DO AGENTE que enviou, nos DOIS caminhos que assinavam com o
 * `nome_ia`. Trabalho de @webtecnica.
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * O #3310 deu à organização o interruptor `assinatura_mensagens.por_agente`:
 * ligado, a IA assina com o nome do AGENTE QUE ENVIOU (`ai_agents.name`), com
 * `nome_ia` como reserva. A leitura mora em `app/api/v1/messages/_handler.ts:665`,
 * e ela usava `ctx.actor.id` — o id do ator.
 *
 * Só que o `id` do ator não é o agente em todos os caminhos:
 *
 * - CENÁRIO A — ação de automação "Mensagem escrita pela IA"
 *   (`lib/automation/actions/send-ai-message.ts:232`): a regra dispara, o TEXTO
 *   é do agente publicado, e o ator sai como `{ type: "webhook_source", id:
 *   <regra> }`. A leitura do nome só rodava para `type === "ai_agent"` — nem
 *   chegava a ser tentada, e a assinatura caía no `nome_ia`.
 *
 * - CENÁRIO B — a 1ª mensagem da Prospecção (`lib/prospecting/worker.ts:458`):
 *   o ator sai `{ type: "ai_agent", id: <candidato>, agent_id: <agente> }`. O
 *   tipo casava, mas o `id` é o CANDIDATO: `nomeDoAgenteDeIA` ia buscar
 *   `ai_agents` por um id que é de `prospecting_candidates`, não achava linha,
 *   e a assinatura caía no `nome_ia` de novo.
 *
 * A coluna certa é `agent_id` — a mesma que o próprio #3310 já descrevia em
 * `lib/api/handlers/types.ts`: "`agent_id` é a linha em `ai_agents`, e é a
 * única que pode ir para uma coluna com FK". O motor do turno
 * (`lib/agent-engine/edge/crm/send-message.ts:200`) continua pondo o agente no
 * `id` (sem `agent_id`), e é esse caminho que a régua `agent_id ?? id` preserva.
 *
 * ─── O que este teste prende ────────────────────────────────────────────────
 *
 * A fiação inteira, num único seam: a AÇÃO registrada executa de verdade, o
 * `sendMessageHandler` roda de verdade, e o que se mede é o TEXTO QUE SAIU ao
 * WhatsApp (o corpo do `/api/sendText`) e a LINHA que ficou gravada em
 * `messages`. O `nomeDoAgenteDeIA` é dublado com o contrato real do banco
 * (busca por id, `null` quando não acha) — porque o que está sob teste é QUAL
 * id chega lá, não a consulta (essa já tem os casos dela em
 * `assinatura-por-agente-3310.test.ts`).
 *
 * Sabotagem que este arquivo pega:
 * - a leitura voltar a usar só `ctx.actor.id` (reverter o fix): A e B assinam
 *   com `nome_ia` → os dois `it` ⭐ caem;
 * - a ação voltar a não passar o agente adiante (`agent_id` sumir do ator):
 *   A cai;
 * - `por_agente` ser ignorado (o #3310 de volta): os casos de regressão caem.
 *
 * Anti-vacuidade: os casos de regressão exigem que a linha chegue ao INSERT e
 * que o canal receba texto — sem eles, um dublê quebrado não se distinguiria do
 * defeito.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type * as EfeitoDeAgenda from "@/lib/agenda/efeito";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type * as OrigemDeAtendimento from "@/lib/atendimento/origem";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

// ─── O nome do agente: contrato do BANCO, não do caminho ────────────────────
// `nomeDoAgenteDeIA(supabase, org, id)` devolve `ai_agents.name` quando o id é
// do agente da organização e `null` quando não acha. Emular isso aqui é o que
// faz o teste medir o caminho: com o id errado (o candidato, a regra) ele
// devolve `null` e a assinatura cai na reserva — exatamente como o Postgres.
vi.mock("@/lib/messaging/nome-do-agente-de-ia", () => ({
  nomeDoAgenteDeIA: vi.fn(async (_supabase: unknown, _org: unknown, agentId: string | null | undefined) =>
    agentId === "66666666-6666-4666-8666-666666666666" ? "Bia da Locação" : null,
  ),
}));
import { nomeDoAgenteDeIA } from "@/lib/messaging/nome-do-agente-de-ia";
const mockedNomeDoAgente = vi.mocked(nomeDoAgenteDeIA);

// ─── A chamada paga ao modelo e as guardas da ação (não decidem a assinatura) ─
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: vi.fn(async () => ({ ok: true, texto: "Oi Thiago, vi seu formulário." })),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/automation/dados-do-formulario", () => ({
  dadosDoFormularioDoContexto: vi.fn(async () => ({ dados: {}, origem: null, origemDaAbordagem: "automacao" })),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: vi.fn(async () => ({ permite: true })),
}));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: vi.fn(async () => {}) }));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: vi.fn(async () => FRONTEIRA),
}));
vi.mock("@/lib/atendimento/origem", async (importOriginal) => ({
  ...(await importOriginal<typeof OrigemDeAtendimento>()),
  assertServiceBoundarySupabase: vi.fn(async () => {}),
}));
vi.mock("@/lib/agenda/efeito", async (importOriginal) => ({
  ...(await importOriginal<typeof EfeitoDeAgenda>()),
  assertAgendaEffectSupabase: vi.fn(async () => {}),
}));
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: vi.fn(async () => {}),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/automation/desfecho-do-envio", () => ({
  reportarEnvio: vi.fn(async (_ctx: unknown, type: string) => ({ type, status: "success", detail: {} })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import "@/lib/automation/actions/send-ai-message";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const AGENTE = "66666666-6666-4666-8666-666666666666";
/** O CANDIDATO da Prospecção — id de `prospecting_candidates`, não de `ai_agents`. */
const CANDIDATO = "99999999-9999-4999-8999-999999999999";
const RULE = "regra-formulario";

const FRONTEIRA = {
  organization_id: ORG,
  contact_id: CONTACT,
  conversation_id: CONV,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

/** A config que LIGA o interruptor do #3310 — o estado sob teste. */
const CONFIG_POR_AGENTE = {
  assinatura_mensagens: { humanos: false, ia: true, nome_ia: "Assistente Virtual", por_agente: true },
};
/** A mesma, com o interruptor DESLIGADO (padrão de toda org que já existia). */
const CONFIG_DESLIGADA = {
  assinatura_mensagens: { humanos: false, ia: true, nome_ia: "Assistente Virtual", por_agente: false },
};

function duble(settings: unknown) {
  return criarDubleDoHandler({
    conversation: {
      id: CONV,
      organization_id: ORG,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      is_group: false,
      group_chat_id: null,
      contacts: { phone_number: "+553****8888", wa_identity: null, wa_lid: null, is_blocked: false },
      channel_sessions: {
        provider: "waha",
        waha_session_name: "default",
        status: "WORKING",
        archived_at: null,
        metadata: {},
      },
    },
    organizacao: { settings, status: "active" },
  });
}

/** WAHA respondendo, com o fetch capturado para ler o corpo que SAIU. */
function wahaRespondendo() {
  vi.stubEnv("WAHA_API_BASE_URL", "http://waha.teste");
  vi.stubEnv("WAHA_API_KEY", "chave-de-teste");
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: "true_595991733685@c.us_3EB0AAAA" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** O texto do `/api/sendText` — o que o CLIENTE vai ler, assinatura incluída. */
function textoQueSaiu(fetchMock: ReturnType<typeof vi.fn>): string | null {
  const sendText = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/sendText"));
  return (JSON.parse(String(sendText?.[1]?.body ?? "{}")).text as string | undefined) ?? null;
}

const texto = (over: Partial<SendMessageInput> = {}): SendMessageInput =>
  ({ conversation_id: CONV, type: "text", body: "oi", ...over }) as SendMessageInput;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mockedNomeDoAgente.mockClear();
});

describe("#3373 · o nome do agente assina nos DOIS caminhos que caíam no nome_ia", () => {
  it("⭐ CENÁRIO A — ação de automação 'Mensagem escrita pela IA' assina com o nome do agente", async () => {
    const fetchMock = wahaRespondendo();
    const { supabase, capturas } = duble(CONFIG_POR_AGENTE);
    const { getAction } = await import("@/lib/automation/actions");

    const resultado = await getAction("send_ai_message")!.execute(
      {
        admin: supabase,
        organizationId: ORG,
        ruleId: RULE,
        ruleName: "Lead do formulário",
        event: { id: "evento-1" } as never,
        context: { contact: { id: CONTACT, phone_number: "+553****8888", is_blocked: false } },
        requestId: "req-3373-a",
      },
      { channel_session_id: SESSION, agent_id: AGENTE, instruction: "Cumprimente o lead pelo nome." },
    );

    expect(
      capturas.inserts.messages ?? [],
      `a ação não chegou ao INSERT: ${JSON.stringify(resultado)}`,
    ).toHaveLength(1);
    expect(
      textoQueSaiu(fetchMock),
      "por_agente ligado e a ação dispara com um agente: o cliente tem que ler o NOME DO AGENTE, não o nome_ia",
    ).toBe("*Bia da Locação*\nOi Thiago, vi seu formulário.");
    // A assinatura entra SÓ no que vai ao canal: o gravado é o texto escrito.
    expect(capturas.inserts.messages!.at(-1)?.["body"]).toBe("Oi Thiago, vi seu formulário.");
    expect(mockedNomeDoAgente).toHaveBeenCalledWith(expect.anything(), ORG, AGENTE);
  });

  it("⭐ CENÁRIO B — a 1ª mensagem da Prospecção assina com o nome do agente, não com o nome_ia", async () => {
    const fetchMock = wahaRespondendo();
    const { supabase, capturas } = duble(CONFIG_POR_AGENTE);

    // O ator EXATO que `lib/prospecting/worker.ts:458` monta para a 1ª bolha:
    // `id` é o candidato, `agent_id` é o agente publicado da campanha.
    const ctxProspeccao: HandlerCtx = {
      organization_id: ORG,
      actor: { type: "ai_agent", id: CANDIDATO, agent_id: AGENTE, role: "ai_operator" },
      requestId: "prospecting:9999:candidato-1",
    };
    const msg = await sendMessageHandler(supabase, ctxProspeccao, texto());

    expect(msg.status, `o envio da Prospecção não saiu: ${JSON.stringify(msg)}`).toBe("sent");
    expect(
      textoQueSaiu(fetchMock),
      "por_agente ligado: a 1ª mensagem da Prospecção tem que assinar com o nome do agente da campanha",
    ).toBe("*Bia da Locação*\noi");
    expect(capturas.inserts.messages!.at(-1)?.["body"]).toBe("oi");
    // O id que chega ao banco é o do AGENTE — nunca o do candidato.
    expect(mockedNomeDoAgente).toHaveBeenCalledWith(expect.anything(), ORG, AGENTE);
    expect(mockedNomeDoAgente).not.toHaveBeenCalledWith(expect.anything(), ORG, CANDIDATO);
  });
});

describe("#3373 · regressão zero: o que continua exatamente como hoje", () => {
  it("interruptor DESLIGADO: a ação assina com o nome_ia, e o nome do agente é lido uma vez, para o balão", async () => {
    const fetchMock = wahaRespondendo();
    const { supabase, capturas } = duble(CONFIG_DESLIGADA);
    const { getAction } = await import("@/lib/automation/actions");

    const resultado = await getAction("send_ai_message")!.execute(
      {
        admin: supabase,
        organizationId: ORG,
        ruleId: RULE,
        ruleName: "Lead do formulário",
        event: { id: "evento-1" } as never,
        context: { contact: { id: CONTACT, phone_number: "+553****8888", is_blocked: false } },
        requestId: "req-3373-c1",
      },
      { channel_session_id: SESSION, agent_id: AGENTE, instruction: "Cumprimente o lead pelo nome." },
    );

    expect(
      capturas.inserts.messages ?? [],
      `a ação não chegou ao INSERT: ${JSON.stringify(resultado)}`,
    ).toHaveLength(1);
    expect(textoQueSaiu(fetchMock)).toBe("*Assistente Virtual*\nOi Thiago, vi seu formulário.");
    // #3649: o nome serve também ao balão ("IA · <nome>"), então é lido mesmo
    // com o interruptor desligado — uma vez, e não entra na assinatura.
    expect(mockedNomeDoAgente).toHaveBeenCalledTimes(1);
    expect(mockedNomeDoAgente).toHaveBeenCalledWith(expect.anything(), ORG, AGENTE);
  });

  it("o motor do turno (ator ai_agent SEM agent_id) continua assinando com o agente do `id`", async () => {
    // `lib/agent-engine/edge/crm/send-message.ts:200` põe o agente no `id` e não
    // manda `agent_id`. A régua `agent_id ?? id` é a que preserva este caminho.
    const fetchMock = wahaRespondendo();
    const { supabase } = duble(CONFIG_POR_AGENTE);

    const ctxMotor: HandlerCtx = {
      organization_id: ORG,
      actor: { type: "ai_agent", id: AGENTE, role: "manager" },
      requestId: "req-3373-c2",
    };
    await sendMessageHandler(supabase, ctxMotor, texto());

    expect(textoQueSaiu(fetchMock)).toBe("*Bia da Locação*\noi");
    expect(mockedNomeDoAgente).toHaveBeenCalledWith(expect.anything(), ORG, AGENTE);
  });

  it("o ator SEM agente (aviso do sistema) continua caindo na reserva, sem ler o banco", async () => {
    const fetchMock = wahaRespondendo();
    const { supabase, capturas } = duble(CONFIG_POR_AGENTE);

    const ctxSemAgente: HandlerCtx = {
      organization_id: ORG,
      actor: { type: "ai_agent", id: "handoff-orchestrator", role: "manager" },
      requestId: "req-3373-c3",
    };
    await sendMessageHandler(supabase, ctxSemAgente, texto());

    expect(textoQueSaiu(fetchMock)).toBe("*Assistente Virtual*\noi");
    expect(capturas.inserts.messages!.at(-1)?.["body"]).toBe("oi");
    // O handler passa o id adiante como sempre; quem barra o id fora do formato
    // de uuid é o próprio `nomeDoAgenteDeIA` (provado em
    // `assinatura-por-agente-3310.test.ts`) — e a reserva é decisão da
    // `nomeDaAssinaturaDaIA`. Aqui se prende o pass-through e a reserva.
    expect(mockedNomeDoAgente).toHaveBeenCalledWith(expect.anything(), ORG, "handoff-orchestrator");
  });

  it("a automação de TEMPLATE (webhook_source sem texto da IA) continua sem assinatura nenhuma", async () => {
    const fetchMock = wahaRespondendo();
    const { supabase } = duble(CONFIG_POR_AGENTE);

    const ctxTemplate: HandlerCtx = {
      organization_id: ORG,
      actor: { type: "webhook_source", id: RULE },
      requestId: "req-3373-c4",
    };
    await sendMessageHandler(supabase, ctxTemplate, texto());

    expect(textoQueSaiu(fetchMock)).toBe("oi");
    expect(mockedNomeDoAgente).not.toHaveBeenCalled();
  });
});
