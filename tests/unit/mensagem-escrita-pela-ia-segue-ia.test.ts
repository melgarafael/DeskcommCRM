/**
 * A MENSAGEM ESCRITA PELA IA SEGUE IA — mesmo quando uma regra a dispara (#652).
 *
 * ─── O que este teste protege ────────────────────────────────────────────────
 *
 * A decisão do mantenedor na #652 (16/09/2026) classifica `messages.sent_via`
 * por AUTORIA: `'automation'` é a mensagem que "não foi escrita nem por pessoa
 * nem pela IA" — template fixo de regra, texto fixo de follow-up, lembrete de
 * agenda. A ação `send_ai_message` ("Mensagem escrita pela IA",
 * `lib/automation/actions/send-ai-message.ts`) é disparada por uma regra, mas o
 * TEXTO é escrito por um agente publicado (`gerarAbordagemDeFormulario`). Pela
 * decisão, a linha é da IA.
 *
 * O risco é silencioso: a ação chama `sendMessageHandler` com
 * `actor: { type: "webhook_source" }` — o MESMO ator das ações de template —, e
 * um carimbo decidido só pelo tipo do ator reclassifica a mensagem da IA como
 * automação sem conflito de merge, sem erro de tipo e sem teste vermelho: o
 * balão passa a dizer "Automação" e a mensagem sai de `envios_por_ia`.
 *
 * ─── Por que merece catraca ──────────────────────────────────────────────────
 *
 * O teste executa a AÇÃO registrada (não a função de decisão) e lê a LINHA que o
 * handler real insere num fake do banco — é a coluna que a tela e a métrica
 * leem. O que é dublado são as guardas e o modelo, que não decidem o carimbo;
 * `sendMessageHandler` e `origemDaMensagem` rodam de verdade.
 *
 * Anti-vacuidade: o caso de controle executa `send_whatsapp_message` (template,
 * mesmo ator) pelo mesmo caminho e exige que a linha exista — sem ele, uma ação
 * que nunca chegasse ao INSERT deixaria o caso principal vermelho pelo motivo
 * errado, e um fake quebrado não seria distinguível do defeito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "@/lib/automation/types";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const AGENTE = "66666666-6666-4666-8666-666666666666";
const BARE = "3EB0ABCDEF0123456789";

const FRONTEIRA = {
  organization_id: ORG,
  contact_id: CONTACT,
  conversation_id: CONV,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

// ─── O modelo: a chamada paga. O texto que ele "escreve" é o dado da ação. ───
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: vi.fn(async () => ({ ok: true, texto: "Oi Thiago, vi seu formulário." })),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/automation/dados-do-formulario", () => ({
  dadosDoFormularioDoContexto: vi.fn(async () => ({ dados: {}, origem: null, origemDaAbordagem: "automacao" })),
}));

// ─── Guardas que não decidem o carimbo ───
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: vi.fn(async () => ({ permite: true })),
}));
vi.mock("@/lib/ai/elegibilidade/autorizacao", () => ({ autorizarContatoParaIA: vi.fn(async () => {}) }));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: vi.fn(async () => FRONTEIRA),
}));
vi.mock("@/lib/atendimento/origem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/atendimento/origem")>()),
  assertServiceBoundarySupabase: vi.fn(async () => {}),
}));
vi.mock("@/lib/agenda/efeito", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agenda/efeito")>()),
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

import { criarDubleDoHandler } from "../helpers/duble-do-handler";
import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/send-ai-message";
import "@/lib/automation/actions/send-whatsapp";

type Row = Record<string, unknown>;

/** Fake do banco no molde de `automacao-carimbo-de-origem.test.ts`: o INSERT guarda a linha. */
/**
 * O banco falso é o COMPARTILHADO (`tests/helpers/duble-do-handler.ts`). Um dublê
 * local a mais faria `send-message-handler-nao-ganha-novo-duble` reprovar — e com
 * razão: cada cópia é um lugar onde o contrato do handler pode divergir do real
 * sem ninguém ver.
 */
function duble() {
  return criarDubleDoHandler({
    conversation: {
      id: CONV,
      organization_id: ORG,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      is_group: false,
      group_chat_id: null,
      contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
      channel_sessions: {
        provider: "waha",
        waha_session_name: "default",
        status: "WORKING",
        archived_at: null,
        metadata: {},
      },
    },
  });
}


function ctxDaRegra(admin: SupabaseClient): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "regra-formulario",
    ruleName: "Lead do formulário",
    event: { id: "evento-1" } as unknown as ActionCtx["event"],
    context: { contact: { id: CONTACT, phone_number: "+5531999998888", is_blocked: false } },
    requestId: "req-652-ia",
  };
}

function wahaRespondendo() {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: { id: BARE } }), { status: 200 })));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a mensagem escrita pela IA numa regra de automação", () => {
  it("⭐ send_ai_message grava sent_via='ai' — a autoria é da IA, não da regra", async () => {
    wahaRespondendo();
    const { supabase, capturas } = duble();

    const resultado = await getAction("send_ai_message")!.execute(ctxDaRegra(supabase), {
      channel_session_id: SESSION,
      agent_id: AGENTE,
      instruction: "Cumprimente o lead pelo nome.",
    });

    expect(capturas.inserts.messages ?? [], `a ação não chegou ao INSERT: ${JSON.stringify(resultado)}`).toHaveLength(1);
    expect(capturas.inserts.messages?.at(-1)?.body).toBe("Oi Thiago, vi seu formulário.");
    expect(
      capturas.inserts.messages?.at(-1)?.sent_via,
      "a mensagem ESCRITA PELA IA foi carimbada como automação — a decisão da #652 é por autoria",
    ).toBe("ai");
  });

  it("CONTROLE: send_whatsapp_message (template da regra) chega ao mesmo INSERT", async () => {
    wahaRespondendo();
    const { supabase, capturas } = duble();

    const resultado = await getAction("send_whatsapp_message")!.execute(ctxDaRegra(supabase), {
      channel_session_id: SESSION,
      template: "Oi, recebemos seu formulário.",
    });

    expect(capturas.inserts.messages ?? [], `o controle não chegou ao INSERT: ${JSON.stringify(resultado)}`).toHaveLength(1);
    expect(capturas.inserts.messages?.at(-1)?.sent_via).not.toBeUndefined();
  });
});
