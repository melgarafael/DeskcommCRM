/**
 * PAUSAR TEM QUE CALAR — inclusive pelo caminho legado.
 *
 * ─── O defeito, medido em produção (VPS `crm.deskcomm.com.br`, 2026-08-28) ───
 *
 * O dono pausa um agente na tela. A tela passa a mostrar **Rascunho**. E ele
 * volta a responder no WhatsApp. A cadeia tem quatro elos, todos na fonte:
 *
 *   1. `pauseAgentAction` (app/app/ai/agents/_actions.ts) limpava
 *      `published_version_id` mas só desligava `is_active` quando
 *      `kind !== "mcp_agent"` — e `mcp_agent` é o que o onboarding cria
 *      (`createDefaultAgent.ts`, `kind: "mcp_agent"`, `is_active: true`).
 *      A rota REST `/api/v1/ai/agents/:id/pause` não escrevia `is_active`
 *      para kind NENHUM.
 *   2. `deriveAgentStatus` ignora `is_active` para `mcp_agent` — e está certo:
 *      quem decide "no ar" para o engine é `published_version_id`. Só que a
 *      coluna continua ligada embaixo, sem nada na tela apontando para ela.
 *   3. `workers/ai-response-worker.ts` escolhe o agente por `.eq("is_active",
 *      true)`, sem `archived_at`, sem `published_version_id` e sem `kind`.
 *   4. A trava que segura esse worker (`skip("engine_owns_reply")`) é
 *      ORG-WIDE: ela só age se existir ALGUM agente publicado na organização.
 *
 * Logo: **pausar o último agente publicado desarma a trava do elo 4 e entrega
 * o atendimento ao elo 3, que ainda enxerga o agente pausado pelo elo 1.**
 * Ele responde com o `system_prompt` da tabela `ai_agents` (o do cadastro, não
 * o da versão publicada), sem as ferramentas, os funis nem os guardrails que a
 * versão carregava.
 *
 * Este arquivo prende o COMPORTAMENTO nas duas pontas — o que o dono pausou
 * fica calado, e o que ele nunca pausou continua atendendo. Só a primeira
 * metade seria satisfeita por um worker que não responde nunca.
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

import { processMessageReceived } from "@/workers/ai-response-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";
const SERVICE = { organization_id: ORG_ID, contact_id: CONTACT_ID, conversation_id: CONV_ID,
  service_revision: 1, demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null };
const AGENT_ID = "88888888-8888-4888-8888-888888888888";
const VERSION_ID = "99999999-9999-4999-8999-999999999999";

/** Neutro de propósito: gatilho de handoff desviaria antes da escolha do agente. */
const INBOUND_BODY = "bom dia, qual o prazo de entrega?";

/** A linha de `ai_agents` do jeito que o banco a entrega ao worker. */
interface AgenteNoBanco {
  kind: string;
  is_active: boolean;
  published_version_id: string | null;
  archived_at: string | null;
}

function makeAdminStub(agente: AgenteNoBanco) {
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
          ? { ...SERVICE, id: MSG_ID, body: INBOUND_BODY, direction: "inbound", organization_id: ORG_ID }
          : table === "ai_agents"
            ? {
                id: AGENT_ID,
                organization_id: ORG_ID,
                model: "anthropic/claude-sonnet-4-6",
                system_prompt: "Você é um atendente.",
                config: { confidence_threshold: 0 },
                guardrails: {},
                active_kb_version_id: VERSION_ID,
                is_active: agente.is_active,
                is_default: true,
                kind: agente.kind,
                published_version_id: agente.published_version_id,
                archived_at: agente.archived_at,
              }
            : null;

    /**
     * O dublê precisa DIZER em que mundo está. O worker faz DUAS perguntas à
     * mesma tabela: "quem é o agente?" e "esta org tem algum publicado?". Um
     * Proxy que devolve a mesma linha às duas faria o worker ceder sempre
     * (`engine_owns_reply`) e o teste ficaria verde medindo o skip errado.
     *
     * A discriminação é o filtro `.not("published_version_id", "is", null)` —
     * e a resposta dela vem do MESMO estado do agente, que é o que torna o
     * dublê fiel: um agente pausado não é publicado para nenhuma das duas.
     */
    let consultaDePublicado = false;
    let filtraNaoArquivado = false;
    let filtraAtivo = false;
    const filtrosDeAgente: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const terminais: any = {
      maybeSingle: () => {
        if (table !== "ai_agents") return Promise.resolve({ data: single, error: null });
        if (consultaDePublicado) {
          const publicado = agente.published_version_id !== null && agente.archived_at === null;
          return Promise.resolve({ data: publicado ? { id: AGENT_ID } : null, error: null });
        }
        return Promise.resolve({ data: linhasDeAgente()[0] ?? null, error: null });
      },
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
              : table === "ai_agents"
                ? linhasDeAgente()
                : [],
          error: null,
        }).then(resolve),
    };

    /**
     * O que o SELECT de agentes devolve, HONRANDO os filtros que o worker
     * pediu. Sem isto o dublê entregaria a linha mesmo quando o worker filtrou
     * corretamente, e os dois casos de controle (`rag_bot` desativado,
     * arquivado) passariam pelo motivo errado — provando o dublê, não o código.
     */
    function linhasDeAgente(): Array<Record<string, unknown>> {
      if (single === null) return [];
      if (filtraAtivo && agente.is_active !== true) return [];
      if (filtraNaoArquivado && agente.archived_at !== null) return [];
      return [single];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(terminais, {
      get: (alvo, prop) =>
        prop in alvo
          ? alvo[prop as keyof typeof alvo]
          : (...args: unknown[]) => {
              if (table === "ai_agents") {
                if (prop === "not" && args[0] === "published_version_id") consultaDePublicado = true;
                if (prop === "is" && args[0] === "archived_at") filtraNaoArquivado = true;
                if (prop === "eq" && args[0] === "is_active") filtraAtivo = true;
                if (typeof args[0] === "string") filtrosDeAgente.push(`${String(prop)}:${args[0]}`);
              }
              return chain;
            },
    });
    return chain;
  };

  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
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

function armar(agente: AgenteNoBanco) {
  const { stub, inserted } = makeAdminStub(agente);
  vi.mocked(createAdminClient).mockReturnValue(stub as unknown as ReturnType<typeof createAdminClient>);
  return inserted;
}

beforeEach(() => {
  vi.clearAllMocks();
  destinos = [];
  fetchOriginal = globalThis.fetch;
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
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe("worker legado — o que a tela chama de Rascunho/Arquivado não responde", () => {
  it("mcp_agent PAUSADO (sem versão publicada) não fala com o cliente", async () => {
    // Exatamente o estado que `pauseAgentAction` deixava para trás: o ponteiro
    // de publicação limpo (tela mostra "Rascunho") e `is_active` intacto.
    armar({ kind: "mcp_agent", is_active: true, published_version_id: null, archived_at: null });

    const result = await processMessageReceived(eventRow);

    expect(
      destinos,
      `o worker chamou o provider por um agente PAUSADO (destinos: ${destinos.join(", ") || "nenhum"})`,
    ).toEqual([]);
    expect(result.status).not.toBe("sent_to_dispatch");
  });

  it("mcp_agent ARQUIVADO não fala com o cliente, mesmo com is_active de pé", async () => {
    // `archiveAgentAction` tem a mesma lacuna de kind; o worker nunca filtrou
    // `archived_at`, então o buraco existe pelos dois lados.
    armar({
      kind: "mcp_agent",
      is_active: true,
      published_version_id: null,
      archived_at: "2026-08-01T00:00:00.000Z",
    });

    const result = await processMessageReceived(eventRow);

    expect(destinos, "o worker respondeu por um agente ARQUIVADO").toEqual([]);
    expect(result.status).not.toBe("sent_to_dispatch");
  });

  it("rag_bot ativo sem versão exige recuperação e não chama o motor retirado", async () => {
    armar({kind:"rag_bot",is_active:true,published_version_id:null,archived_at:null});
    const result=await processMessageReceived(eventRow);
    expect(destinos).toEqual([]);
    expect(result).toMatchObject({status:"skipped",reason:"agent_inactive_or_missing"});
  });

  it("rag_bot DESATIVADO não fala com o cliente", async () => {
    armar({ kind: "rag_bot", is_active: false, published_version_id: null, archived_at: null });

    const result = await processMessageReceived(eventRow);

    expect(destinos).toEqual([]);
    expect(result.status).not.toBe("sent_to_dispatch");
  });
});
