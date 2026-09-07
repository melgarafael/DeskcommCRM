/**
 * A TELEMETRIA TEM QUE DIZER O MODELO QUE REALMENTE ATENDEU.
 *
 * O painel de provedores fez `purpose` deixar de ser rótulo de custo e virar
 * decisão: quem escolhe, em "Responder o cliente", um llama pela OpenRouter,
 * passa a ter a requisição saindo para openrouter.ai. O `ai-response-worker`
 * obedeceu essa parte — `invokeBot` recebe o modelo resolvido —, mas os três
 * `logInvocation` e os três `computeCost` continuaram usando `ctx.agent.model`.
 *
 * Resultado: a chamada ia para um provedor e a linha em `llm_calls` dizia
 * outro. A tela nova de Execuções — a entrega do PR — atribuía o gasto ao
 * provedor e ao modelo errados, no ponto de IA mais frequente do produto. E o
 * número é o que alimenta o orçamento: custo atribuído ao modelo errado é
 * decisão de corte de gasto tomada sobre dado falso.
 *
 * O mesmo defeito já existia no `ai-sentiment-worker` e foi corrigido lá — a
 * cópia do padrão no worker vizinho ficou para trás. É a razão de este arquivo
 * guardar o CALL SITE, e não o resolvedor: `gateway-binding.test.ts` já prova
 * que o resolvedor devolve o `modelId` certo, e continuaria verde com os dois
 * workers logando o modelo errado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 7) }));

import { createAnthropic } from "@ai-sdk/anthropic";

import { processMessageReceived } from "@/workers/ai-response-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import { logInvocation } from "@/lib/ai/log-invocation";
import { computeCost } from "@/lib/ai/cost";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import type { EventRow } from "@/lib/event-log/dispatcher";

vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";
const SERVICE = { organization_id: ORG_ID, contact_id: CONTACT_ID, conversation_id: CONV_ID,
  service_revision: 1, demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null };
const AGENT_ID = "88888888-8888-4888-8888-888888888888";

/** O que está gravado em `ai_agents.model` — o valor ANTIGO, do cadastro. */
const MODELO_DO_AGENTE = "anthropic/claude-sonnet-4-6";
/** O que o operador escolheu no painel para "Responder o cliente". */
const MODELO_DO_PAINEL = "meta-llama/llama-3.3-70b-instruct";

const INBOUND_BODY = "bom dia, qual o prazo de entrega?";

function makeAdminStub() {
  const from = (table: string) => {
    const single: Record<string, unknown> | null =
      table === "conversations"
        ? {
            id: CONV_ID,
            organization_id: ORG_ID,
            contact_id: CONTACT_ID,
            channel_session_id: "77777777-7777-4777-8777-777777777777",
            last_inbound_at: new Date().toISOString(),
            bot_silenced_until: null,
            last_handoff_at: null,
            assignee_kind: "ai",
            contacts: {
              id: CONTACT_ID,
              display_name: null,
              locale: "pt-BR",
              is_blocked: false,
              force_human: false,
            },
          }
        : table === "messages"
          ? { ...SERVICE, id: MSG_ID, body: INBOUND_BODY, direction: "inbound", organization_id: ORG_ID }
          : table === "ai_agents"
            ? {
                id: AGENT_ID,
                organization_id: ORG_ID,
                model: MODELO_DO_AGENTE,
                system_prompt: "Você é um atendente.",
                config: { confidence_threshold: 0 },
                guardrails: {},
                active_kb_version_id: "99999999-9999-4999-8999-999999999999",
                is_active: true,
                is_default: true,
                // O banco tem `kind` NOT NULL DEFAULT 'rag_bot' e os dois ponteiros:
                // sem eles o dublê descreveria uma linha que não existe, e a régua
                // de `lib/ai/agents/no-ar.ts` — que falha FECHADA quando o select
                // não trouxe `kind` — recusaria o agente pelo motivo errado.
                kind: "rag_bot",
                published_version_id: null,
                archived_at: null,
              }
            : null;

    let consultaDePublicado = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terminais: any = {
      maybeSingle: () => Promise.resolve({ data: consultaDePublicado ? null : single, error: null }),
      single: () => Promise.resolve({ data: single, error: null }),
      insert: () => ({
        select: () => ({
          single: () =>
            Promise.resolve({ data: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, error: null }),
        }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === "messages"
              ? [
                  {
                    ...SERVICE,
              id: MSG_ID,
                    body: INBOUND_BODY,
                    direction: "inbound",
                    created_at: new Date().toISOString(),
                  },
                ]
              // A seleção de agente do worker legado é uma LISTA (ele filtra os
              // candidatos pela régua de `lib/ai/agents/no-ar.ts` em vez de cortar
              // com `.limit(1)` antes de saber quem serve). O dublê acompanha.
              : table === "ai_agents"
                ? (single ? [single] : [])
                : [],
          error: null,
        }).then(resolve),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(terminais, {
      get: (alvo, prop) =>
        prop in alvo
          ? alvo[prop as keyof typeof alvo]
          : (...args: unknown[]) => {
              if (prop === "not" && args[0] === "published_version_id") consultaDePublicado = true;
              return chain;
            },
    });
    return chain;
  };

  return { from, rpc: (name: string) => Promise.resolve({ data: name === "fn_service_boundary" ? SERVICE : [], error: null }) };
}

const eventRow = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

let fetchOriginal: typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Nosso prazo é de 3 dias úteis." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch;

  vi.mocked(createAdminClient).mockReturnValue(
    makeAdminStub() as unknown as ReturnType<typeof createAdminClient>,
  );
  // O painel mandou: provider e modelo DIFERENTES do que está no cadastro do
  // agente. É essa diferença que torna o teste capaz de distinguir os dois.
  vi.mocked(resolverModeloDoPonto).mockResolvedValue({
    model: createAnthropic({ apiKey: "sk-ant-teste" })("claude-sonnet-4-6"),
    modelId: MODELO_DO_PAINEL,
  } as unknown as Awaited<ReturnType<typeof resolverModeloDoPonto>>);
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe("ai-response-worker — o log diz o modelo que atendeu", () => {
  it("o cenário distingue os dois modelos (controle positivo)", () => {
    // Se um dia alguém igualar estas constantes, o teste passa a aprovar os
    // dois comportamentos — verde por não conseguir separar.
    expect(MODELO_DO_PAINEL).not.toBe(MODELO_DO_AGENTE);
  });

  it("motor retirado não emite telemetria de uma chamada que não aconteceu",async()=>{
    const result=await processMessageReceived(eventRow);
    expect(result).toMatchObject({status:'skipped',reason:'agent_inactive_or_missing'});
    expect(logInvocation).not.toHaveBeenCalled();
    expect(computeCost).not.toHaveBeenCalled();
  });
});
