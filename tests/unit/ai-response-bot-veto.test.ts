/**
 * G3-02 acceptance 3 — regra determinística: conversa com assignee_kind='user'
 * (humano atendendo) VETA o pipeline de resposta do bot, na mesma família de
 * guard de force_human/bot_silenced_until (workers/ai-response-worker.ts).
 *
 * Prova, contra o worker REAL (admin client e gateway mockados):
 *  - kind='user' → skip 'assigned_to_human' ANTES de qualquer leitura de
 *    mensagem (nenhuma query além dos candidatos legados e de conversations);
 *  - kind='ai' → o guard NÃO veta: o pipeline avança até o próximo passo
 *    (aqui, há versão publicada na org → 'engine_owns_reply').
 *
 * A org tem um `rag_bot` sem versão: sem candidato legado o worker sai na
 * primeira consulta, antes de olhar a conversa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processMessageReceived } from "@/workers/ai-response-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRow } from "@/lib/event-log/dispatcher";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_BOT_MODEL: "anthropic/claude-sonnet-4-6",
  gatewayConfig: {},
  gatewayHeaders: () => ({}),
  isEmbeddingProviderConfigured: () => false,
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";

/** O candidato legado (lista) e, na checagem `.maybeSingle()`, o "há versão publicada". */
const AGENTE_LEGADO = {
  id: "88888888-8888-4888-8888-888888888888",
  organization_id: ORG_ID,
  kind: "rag_bot",
  is_active: true,
  published_version_id: null,
  archived_at: null,
  paused_at: null,
};

interface StubTables {
  conversations: Record<string, unknown> | null;
  messages: Record<string, unknown> | null;
  /** O que `ai_agents` devolve; o padrão é o `rag_bot` legado. */
  ai_agents?: Record<string, unknown>;
}

function makeAdminStub(tables: StubTables, queried: string[]) {
  const from = (table: string) => {
    const result =
      table === "conversations"
        ? tables.conversations
        : table === "messages"
          ? tables.messages
          : table === "ai_agents"
            ? (tables.ai_agents ?? AGENTE_LEGADO)
            : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      // `.is("archived_at", null)`: o worker legado passou a filtrar agente
      // arquivado no SELECT, e um dublê literal quebra a cada filtro novo.
      is: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: result, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: result ? [result] : [], error: null }).then(resolve),
    };
    queried.push(table);
    return chain;
  };
  return { from };
}

function convRow(assigneeKind: string | null) {
  return {
    id: CONV_ID,
    organization_id: ORG_ID,
    contact_id: "66666666-6666-4666-8666-666666666666",
    channel_session_id: "77777777-7777-4777-8777-777777777777",
    last_inbound_at: new Date().toISOString(),
    bot_silenced_until: null,
    last_handoff_at: null,
    assignee_kind: assigneeKind,
    organizations: { status: "active" },
    contacts: {
      id: "66666666-6666-4666-8666-666666666666",
      display_name: null, // sem PII em teste (LGPD)
      locale: "pt-BR",
      is_blocked: false,
      force_human: false,
    },
  };
}

const eventRow = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guard determinístico do bot — assignee_kind (G3-02)", () => {
  it("kind='user' (humano atendendo) → bot NÃO dispara: skip 'assigned_to_human'", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeAdminStub({ conversations: convRow("user"), messages: null }, queried) as any,
    );

    const result = await processMessageReceived(eventRow);

    expect(result).toEqual({ status: "skipped", reason: "assigned_to_human" });
    // Veto é determinístico e imediato: além dos candidatos, só a conversa foi
    // lida — nada do resto do pipeline (mensagem, budget) foi consultado.
    expect(queried).toEqual(["ai_agents", "conversations"]);
  });

  it("kind='ai' → o guard não veta e o pipeline avança além dele", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub(
        {
          conversations: convRow("ai"),
          messages: { id: MSG_ID, body: "oi", direction: "inbound", organization_id: ORG_ID },
        },
        queried,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any,
    );

    const result = await processMessageReceived(eventRow);

    // Avançou até a trava do engine (o dublê responde "há publicado"): prova
    // que o guard de assignment deixou passar quando a IA é a assignee.
    expect(result.reason).toBe("engine_owns_reply");
    expect(queried).toContain("messages");
    expect(queried).toContain("ai_agents");
  });

  it("kind=null (fila) → guard também não veta", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub(
        {
          conversations: convRow(null),
          messages: { id: MSG_ID, body: "oi", direction: "inbound", organization_id: ORG_ID },
        },
        queried,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any,
    );

    const result = await processMessageReceived(eventRow);
    expect(result.reason).toBe("engine_owns_reply");
  });
});

describe("sem candidato legado, o worker não olha a conversa", () => {
  it("org só com agente publicado: uma consulta e sai", async () => {
    // O caso de quase toda instalação: o engine atende, e este worker recebe
    // `message.received` de cada mensagem mesmo assim.
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub(
        {
          conversations: convRow("ai"),
          messages: { id: MSG_ID, body: "quero falar com um atendente", direction: "inbound", organization_id: ORG_ID },
          ai_agents: { ...AGENTE_LEGADO, kind: "mcp_agent", published_version_id: "99999999-9999-4999-8999-999999999999" },
        },
        queried,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any,
    );

    const result = await processMessageReceived(eventRow);

    expect(result).toEqual({ status: "skipped", reason: "agent_inactive_or_missing", detail: undefined });
    expect(queried, "leu a conversa de uma org que este worker não atende").toEqual(["ai_agents"]);
  });
});
