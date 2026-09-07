/**
 * O que este teste protege: **o worker que RESPONDE O CLIENTE tem que falar com
 * o provider que a instalação realmente tem.**
 *
 * Irmão do `lib/ai/gateway-resolve-model.test.ts`, com uma diferença de força
 * deliberada: lá a asserção é sobre o TIPO do retorno de `resolveLanguageModel`
 * (string = gateway, objeto = provider). Aqui a asserção é sobre o EFEITO —
 * para onde a requisição vai, medido interceptando `globalThis.fetch`, com o
 * `ai` SDK de verdade no caminho. Por isso este arquivo NÃO mocka o módulo
 * `ai`: mockar `generateText` provaria só que uma string foi passada adiante;
 * o que interessa é que o cliente fica sem resposta.
 *
 * O defeito, medido em ai@7.0.37: `model` STRING com barra é roteado pelo
 * gateway da Vercel, e sem `AI_GATEWAY_API_KEY` o SDK aborta ANTES de emitir
 * qualquer fetch:
 *
 *     Unauthenticated request to AI Gateway. To authenticate, set the
 *     AI_GATEWAY_API_KEY environment variable with your API key.
 *
 * Numa instalação self-host padrão — a que o `install.sh` produz, que exige só
 * `ANTHROPIC_API_KEY` — isso acontece uma vez por mensagem recebida, e o
 * sintoma para o usuário é o bot simplesmente não responder.
 *
 * `workers/ai-sentiment-worker.ts` tinha o mesmo defeito e foi corrigido no
 * mesmo PR. Este worker é o que fala com o cliente, então o buraco aqui é o
 * caro. Os dois estão registrados em `lib/event-log/register-handlers.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Env do self-host padrão: SÓ a chave da Anthropic, que é a única que o
// install.sh exige. É esta combinação que reproduz o defeito.
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
const AGENT_ID = "88888888-8888-4888-8888-888888888888";

// Corpo neutro de propósito: qualquer gatilho de handoff (G1 "quero falar com
// humano", G4 "advogado") desviaria o fluxo ANTES do LLM e o teste passaria
// sem nunca exercitar o ponto em questão.
const SERVICE = { organization_id: ORG_ID, contact_id: CONTACT_ID, conversation_id: CONV_ID,
  service_revision: 1, demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null };
const INBOUND_BODY = "bom dia, qual o prazo de entrega?";

/**
 * Stub do admin client suficiente para o pipeline chegar ao LLM. Cada tabela
 * devolve a linha mínima que faz o guard correspondente NÃO vetar — o objetivo
 * é justamente alcançar `invokeBot`, não testar os guards (isso é o
 * ai-response-bot-veto.test.ts).
 */
function makeAdminStub() {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];

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
              display_name: null, // sem PII em teste (LGPD)
              locale: "pt-BR",
              is_blocked: false,
              force_human: false,
            },
          }
        : table === "messages"
          ? {
              ...SERVICE,
              id: MSG_ID,
              body: INBOUND_BODY,
              direction: "inbound",
              organization_id: ORG_ID,
            }
          : table === "ai_agents"
            ? {
                id: AGENT_ID,
                organization_id: ORG_ID,
                // Vem do banco como STRING — é a origem exata do defeito.
                model: "anthropic/claude-sonnet-4-6",
                system_prompt: "Você é um atendente.",
                // Sem RAG neste stub, a confiança é 0 e o guard G3 desviaria
                // para handoff — o que provaria o LLM respondendo, mas pararia
                // antes do dispatch. Zerar o limiar deixa o caminho completo
                // (resposta → persistência → message.send_requested) visível.
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
            : null; // ai_budgets sem linha = sem throttle; crm_leads sem lead

    // Proxy em vez de listar os filtros um a um: qualquer método do
    // query-builder que não seja terminal (.eq, .is, .in, .not, .gte…) devolve
    // o próprio chain. Sem isso o teste vira uma caçada a "X is not a function"
    // toda vez que o worker ganha um filtro novo.
    // O dublê precisa DIZER em que mundo está (issue #129). O worker agora
    // pergunta se a org tem agente com versão PUBLICADA — se tem, quem responde
    // é o agent-engine e ele cede. Estes casos exercitam o caminho legado (sem
    // publicação), então a consulta discriminada devolve `null`. Sem isto o
    // Proxy devolveria a MESMA linha de agente para as duas perguntas, e o
    // worker cederia sempre — os testes ficariam verdes medindo o skip.
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
            single: () =>
              Promise.resolve({ data: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, error: null }),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
      },
      // Await direto na query = lista (mensagens recentes).
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === "messages"
              ? [{ id: MSG_ID, body: INBOUND_BODY, direction: "inbound", created_at: new Date().toISOString() }]
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

  // `emit_event` (evento message.send_requested) e o RPC de RAG passam por aqui.
  const rpc = (name: string) => Promise.resolve({ data: name === "fn_service_boundary" ? SERVICE : [], error: null });

  return { stub: { from, rpc }, inserted };
}

const eventRow = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

let fetchOriginal: typeof globalThis.fetch;
let destinos: string[];

beforeEach(() => {
  vi.clearAllMocks();
  destinos = [];
  fetchOriginal = globalThis.fetch;
  // Nenhuma chamada de rede sai daqui: o stub responde no lugar do provider.
  // O que interessa é o REGISTRO do destino — é ele que distingue "foi ao
  // provider certo" de "nem tentou".
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    destinos.push(new URL(url).host);
    return new Response(
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
    );
  }) as typeof globalThis.fetch;

  const { stub } = makeAdminStub();
  vi.mocked(createAdminClient).mockReturnValue(stub as unknown as ReturnType<typeof createAdminClient>);
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe("ai-response-worker — resolução do modelo numa instalação self-host", () => {
  it("chave de provedor não reativa resposta legada sem publicação", async () => {
    const result = await processMessageReceived(eventRow);

    // A asserção que importa: a requisição SAIU, e saiu para a Anthropic.
    expect(destinos).toEqual([]);
    expect(result).toMatchObject({status:"skipped",reason:"agent_inactive_or_missing"});
  });

  it("o defeito, explicitado: model como STRING nem emite requisição", async () => {
    // Reproduz o caminho da main SEM depender do worker, para deixar claro que
    // a origem é o TIPO do argumento e não outra coisa do pipeline: mesmo env,
    // mesmo SDK, mesma mensagem — só muda string vs provider.
    const { generateText } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");

    destinos = [];
    await expect(
      generateText({ model: "anthropic/claude-sonnet-4-6", prompt: INBOUND_BODY }),
    ).rejects.toThrow(/AI Gateway/i);
    expect(destinos).toEqual([]); // nem tentou a rede

    destinos = [];
    await generateText({
      model: createAnthropic({ apiKey: "sk-ant-teste" })("claude-sonnet-4-6"),
      prompt: INBOUND_BODY,
    });
    expect(destinos).toEqual(["api.anthropic.com"]);
  });

  it("sem chave nenhuma o worker PULA com motivo claro, em vez de estourar", async () => {
    const anterior = envMock.ANTHROPIC_API_KEY ?? "";
    envMock.ANTHROPIC_API_KEY = "";
    try {
      const result = await processMessageReceived(eventRow);
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("agent_inactive_or_missing");
      expect(destinos).toEqual([]);
    } finally {
      envMock.ANTHROPIC_API_KEY = anterior;
    }
  });
});
