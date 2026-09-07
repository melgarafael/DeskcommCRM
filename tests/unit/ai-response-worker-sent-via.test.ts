/**
 * O que este teste protege: **a resposta da IA tem que CABER no banco.**
 *
 * O worker monta a linha outbound em `persistAndDispatch` e a grava em
 * `public.messages`, que tem a constraint `messages_sent_via_check` limitando
 * `sent_via` a um vocabulário fechado. Um valor fora dele não é rejeitado pelo
 * TypeScript (`lib/database.types.ts` tipa a coluna como `string`) nem por
 * nenhum gate do CI — o insert só falha em runtime, contra o Postgres, com:
 *
 *     outbound_insert_failed: new row for relation "messages" violates
 *     check constraint "messages_sent_via_check"
 *
 * Foi exatamente o que aconteceu: a main gravava `sent_via: "bot"`, valor que
 * nunca esteve na constraint. Como o insert é o ÚLTIMO passo do pipeline, o
 * LLM já foi chamado e pago quando a linha estoura; o evento volta para
 * `event_log` e é retentado até morrer em `dead` (5 tentativas), queimando uma
 * invocação do provider por tentativa. Para o usuário, o bot simplesmente não
 * responde.
 *
 * Por que este arquivo é necessário mesmo com o `ai-response-worker-model-routing.test.ts`
 * verde: o stub daquele teste aceita QUALQUER insert. Ele exercita o caminho
 * inteiro (`sent_to_dispatch` só existe depois que `persistAndDispatch`
 * retorna) e ainda assim passava com o valor inválido — o mock não tinha a
 * constraint. Aqui o stub valida contra o vocabulário **lido do
 * `supabase/baseline.sql`**, que é o schema que o self-hoster realmente aplica.
 * Ler do schema em vez de repetir a lista no teste é o que impede o teste de
 * concordar com o worker e os dois estarem errados juntos.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Env do self-host padrão: só a chave da Anthropic (o que o install.sh exige).
// Sem chave de embedding o RAG é pulado, então a confiança é 0 — é isso que
// deixa o gatilho G3 controlável só pelo `confidence_threshold` do agente.
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

// Corpo neutro: qualquer gatilho de handoff (G1 "falar com humano", G4
// "advogado") desviaria o fluxo ANTES do LLM e o insert nunca aconteceria.
const SERVICE = { organization_id: ORG_ID, contact_id: CONTACT_ID, conversation_id: CONV_ID,
  service_revision: 1, demanda_id: null, demanda_revision: null, status: "open", demanda_fechada_em: null };
const INBOUND_BODY = "bom dia, qual o prazo de entrega?";

/**
 * Vocabulário de `sent_via` extraído do `supabase/baseline.sql` — o mesmo
 * arquivo que o `install.sh`/`update.sh` aplicam na VPS do cliente.
 */
function vocabularioDoSchema(): string[] {
  const baseline = readFileSync(
    path.resolve(process.cwd(), "supabase/baseline.sql"),
    "utf8",
  );
  const check = /CONSTRAINT "messages_sent_via_check" CHECK \(\("sent_via" = ANY \(ARRAY\[([^\]]+)\]/
    .exec(baseline);
  if (!check?.[1]) {
    throw new Error(
      "não achei messages_sent_via_check no supabase/baseline.sql — " +
        "se a constraint mudou de forma, conserte esta extração em vez de apagar o teste",
    );
  }
  return [...check[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

const SENT_VIA_PERMITIDOS = vocabularioDoSchema();

interface LinhaInserida {
  table: string;
  row: Record<string, unknown>;
}

/**
 * Stub do admin client que, ao contrário do usado no teste de roteamento de
 * modelo, APLICA a constraint de `sent_via` em `messages` — devolvendo o mesmo
 * formato de erro do PostgREST (código 23514) que o worker recebe do banco.
 */
function makeAdminStub(confidenceThreshold: number) {
  const inserted: LinhaInserida[] = [];

  const from = (table: string) => {
    const single: Record<string, unknown> | null =
      table === "conversations"
        ? {
            id: CONV_ID,
            organization_id: ORG_ID,
            contact_id: CONTACT_ID,
            channel_session_id: SESSION_ID,
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
                config: { confidence_threshold: confidenceThreshold },
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

        // É AQUI que este teste difere do irmão: o banco de verdade recusa um
        // `sent_via` fora do vocabulário, então o stub recusa também.
        const sentVia = row["sent_via"];
        const violaCheck =
          table === "messages" &&
          typeof sentVia === "string" &&
          !SENT_VIA_PERMITIDOS.includes(sentVia);
        const erro = violaCheck
          ? {
              code: "23514",
              message:
                'new row for relation "messages" violates check constraint "messages_sent_via_check"',
            }
          : null;

        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                erro ? { data: null, error: erro } : { data: { id: OUTBOUND_ID }, error: null },
              ),
          }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: erro }).then(resolve),
        };
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === "messages"
              ? [
                  {
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

  const rpc = (name: string) => Promise.resolve({ data: name === "fn_service_boundary" ? SERVICE : [], error: null });

  return { stub: { from, rpc }, inserted };
}

const eventRow = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

let fetchOriginal: typeof globalThis.fetch;

/** Instala o stub e devolve o registro de inserts para asserção. */
function prepararWorker(confidenceThreshold: number): LinhaInserida[] {
  const { stub, inserted } = makeAdminStub(confidenceThreshold);
  vi.mocked(createAdminClient).mockReturnValue(
    stub as unknown as ReturnType<typeof createAdminClient>,
  );
  return inserted;
}

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

describe("ai-response-worker — a linha outbound cabe na constraint de sent_via", () => {
  it("o vocabulário veio mesmo do baseline (controle do instrumento)", () => {
    // Sem esta guarda, uma regex que parasse de casar devolveria lista vazia e
    // TODA asserção de pertinência abaixo passaria a ser trivialmente falsa —
    // ou, pior, um `includes` sobre lista vazia reprovaria por motivo errado.
    expect(SENT_VIA_PERMITIDOS.length).toBeGreaterThan(1);
    expect(SENT_VIA_PERMITIDOS).toContain("ai");
    expect(SENT_VIA_PERMITIDOS).not.toContain("bot");
  });

  it.each([0,1])("limiar G3 %s não cria rascunho/outbound do motor retirado",async threshold=>{
    const inserted=prepararWorker(threshold);
    const result=await processMessageReceived(eventRow);
    expect(result).toMatchObject({status:"skipped",reason:"agent_inactive_or_missing"});
    expect(inserted.filter(i=>i.table==='messages'&&i.row.direction==='outbound')).toEqual([]);
    expect(inserted.filter(i=>i.table==='event_log'&&i.row.event_type==='message.send_requested')).toEqual([]);
  });
});
