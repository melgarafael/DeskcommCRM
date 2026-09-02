/**
 * Bug crítico achado ao comparar com o changelog do upstream (DeskcommCRM 1.5.0):
 * quando um atendente humano assumia uma conversa ENQUANTO a IA já estava
 * gerando uma resposta (a chamada ao LLM leva segundos), o worker despachava a
 * resposta da IA mesmo assim — os dois respondiam o mesmo cliente ao mesmo
 * tempo.
 *
 * Causa raiz: `buildContext` lê `conversations.assignee_kind` só UMA vez, no
 * INÍCIO do turno (`tests/unit/ai-response-bot-veto.test.ts` prova esse guard
 * isolado). Entre essa leitura e o INSERT final em `persistAndDispatch` — que
 * só acontece DEPOIS da chamada ao LLM — nada relia o estado. Um humano que
 * clicasse "Assumir" nesse intervalo não era visto.
 *
 * O fix relê `assignee_kind` FRESCO dentro de `persistAndDispatch`, logo antes
 * do insert real (não no caminho `skipDispatch` do G3, que nunca chega ao
 * cliente de qualquer forma). Este teste simula a corrida com um stub que
 * devolve um valor DIFERENTE na segunda leitura de `conversations` — é
 * exatamente essa mudança de estado entre a leitura inicial e o envio final
 * que o bug ignorava.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Env do self-host padrão: só a chave da Anthropic (o que o install.sh exige).
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

import { processMessageReceived } from "@/workers/ai-response-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";
const SESSION_ID = "77777777-7777-4777-8777-777777777777";
const AGENT_ID = "88888888-8888-4888-8888-888888888888";
const OUTBOUND_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const INBOUND_BODY = "bom dia, qual o prazo de entrega?";

interface LinhaInserida {
  table: string;
  row: Record<string, unknown>;
}

/**
 * Stub cujo `conversations.assignee_kind` muda de valor a cada leitura — a
 * PRIMEIRA (dentro de `buildContext`) devolve o kind inicial; a partir da
 * SEGUNDA (o re-check dentro de `persistAndDispatch`, depois do LLM) devolve
 * `depoisKind`. Simula exatamente a corrida: o dono da conversa muda enquanto
 * o LLM está gerando.
 */
function makeAdminStub(antesKind: string | null, depoisKind: string | null) {
  const inserted: LinhaInserida[] = [];
  let leiturasDeConversation = 0;

  const from = (table: string) => {
    let single: Record<string, unknown> | null = null;
    if (table === "conversations") {
      leiturasDeConversation += 1;
      const kind = leiturasDeConversation === 1 ? antesKind : depoisKind;
      single = {
        id: CONV_ID,
        organization_id: ORG_ID,
        contact_id: CONTACT_ID,
        channel_session_id: SESSION_ID,
        last_inbound_at: new Date().toISOString(),
        bot_silenced_until: null,
        last_handoff_at: null,
        assignee_kind: kind,
        contacts: {
          id: CONTACT_ID,
          display_name: null,
          locale: "pt-BR",
          is_blocked: false,
          force_human: false,
        },
      };
    } else if (table === "messages") {
      single = { id: MSG_ID, body: INBOUND_BODY, direction: "inbound", organization_id: ORG_ID };
    } else if (table === "ai_agents") {
      single = {
        id: AGENT_ID,
        organization_id: ORG_ID,
        model: "anthropic/claude-sonnet-4-6",
        system_prompt: "Você é um atendente.",
        config: { confidence_threshold: 0 },
        guardrails: {},
        active_kb_version_id: "99999999-9999-4999-8999-999999999999",
        is_active: true,
        is_default: true,
      };
    }

    let consultaDePublicado = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terminais: any = {
      maybeSingle: () =>
        Promise.resolve({ data: consultaDePublicado ? null : single, error: null }),
      single: () => Promise.resolve({ data: single, error: null }),
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: OUTBOUND_ID }, error: null }),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === "messages"
              ? [{ id: MSG_ID, body: INBOUND_BODY, direction: "inbound", created_at: new Date().toISOString() }]
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

  const rpc = () => Promise.resolve({ data: [], error: null });
  return { stub: { from, rpc }, inserted };
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
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe("ai-response-worker — corrida entre buildContext e o envio final", () => {
  it("humano assume DURANTE a geração: a resposta da IA NUNCA é inserida", async () => {
    const { stub, inserted } = makeAdminStub("ai", "user");
    vi.mocked(createAdminClient).mockReturnValue(stub as unknown as ReturnType<typeof createAdminClient>);

    const result = await processMessageReceived(eventRow);

    const outboundInserido = inserted.some(
      (i) => i.table === "messages" && i.row["direction"] === "outbound",
    );
    expect(outboundInserido, "a resposta da IA foi inserida mesmo com humano já assumindo").toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("assigned_to_human");
  });

  it("sem corrida (kind='ai' nas duas leituras): despacha normalmente", async () => {
    const { stub, inserted } = makeAdminStub("ai", "ai");
    vi.mocked(createAdminClient).mockReturnValue(stub as unknown as ReturnType<typeof createAdminClient>);

    const result = await processMessageReceived(eventRow);

    const outboundInserido = inserted.some(
      (i) => i.table === "messages" && i.row["direction"] === "outbound",
    );
    expect(outboundInserido).toBe(true);
    expect(result.status).toBe("sent_to_dispatch");
    expect(result.outbound_message_id).toBe(OUTBOUND_ID);
  });
});
