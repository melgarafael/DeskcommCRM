/**
 * R1 — o worker LEGADO (`workers/ai-response-worker.ts`, o caminho pré-engine
 * para orgs sem versão de agente publicada) TAMBÉM respeita o gate de
 * elegibilidade. Sem isto, ligar `channel_sessions.metadata.ai_gate='allowlist'`
 * num canal não fazia nada nessas orgs: o log não reclamava e a IA seguia
 * respondendo todo mundo por aqui (a "falha-em-verde" da doutrina).
 *
 * Prova, contra o worker REAL (admin client + gateway mockados):
 *  - gate 'allowlist' + contato não autorizado → skip 'nao_elegivel_para_ia',
 *    ANTES de qualquer leitura de mensagem/agente;
 *  - gate 'open' (default) → o guard não veta;
 *  - erro na leitura da elegibilidade → skip 'nao_elegivel_para_ia' (fail-closed).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `lib/env.ts` valida na importação e o worker o alcança via
// `aes_gcm`/`gateway`. Mesma isca dos irmãos (`ai-response-worker-sent-via`):
// só a chave da Anthropic, como o `install.sh` produz.
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
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_BOT_MODEL: "anthropic/claude-sonnet-4-6",
  gatewayConfig: {},
  gatewayHeaders: () => ({}),
  isAiGatewayConfigured: () => true,
  isEmbeddingProviderConfigured: () => false,
}));

import { processMessageReceived } from "@/workers/ai-response-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const MSG_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";

interface ConvOpts {
  aiGate?: string | null;
  aiAuthorizedAt?: string | null;
  convError?: string;
}

function makeAdminStub(opts: ConvOpts, queried: string[]) {
  const convRow = {
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
      ai_authorized_at: opts.aiAuthorizedAt ?? null,
    },
    channel_sessions: { metadata: opts.aiGate != null ? { ai_gate: opts.aiGate } : {} },
  };

  const from = (table: string) => {
    queried.push(table);
    const result = table === "conversations" ? convRow : table === "messages" ? { id: MSG_ID, body: "oi", direction: "inbound", organization_id: ORG_ID } : null;
    let selectCols = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols?: string) => {
        selectCols = cols ?? "";
        return chain;
      },
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        // O erro só na consulta de ELEGIBILIDADE (embed de channel_sessions),
        // não na leitura própria do buildContext.
        const ehConsultaElegibilidade =
          table === "conversations" && selectCols.includes("channel_sessions:channel_session_id");
        if (ehConsultaElegibilidade && opts.convError) {
          return Promise.resolve({ data: null, error: { message: opts.convError } });
        }
        return Promise.resolve({ data: result, error: null });
      },
      then: (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: result ? [result] : [], error: null }).then(r),
    };
    return chain;
  };
  return { from } as never;
}

const eventRow = {
  organization_id: ORG_ID,
  entity_id: MSG_ID,
  payload: { message_id: MSG_ID, conversation_id: CONV_ID },
} as unknown as EventRow;

beforeEach(() => vi.clearAllMocks());

describe("ai-response-worker (legado) · gate de elegibilidade", () => {
  it("gate 'allowlist' + contato NÃO autorizado → skip 'nao_elegivel_para_ia'", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ aiGate: "allowlist", aiAuthorizedAt: null }, queried),
    );
    const result = await processMessageReceived(eventRow);
    expect(result).toMatchObject({ status: "skipped", reason: "nao_elegivel_para_ia" });
    expect(queried).not.toContain("messages");
    expect(queried).not.toContain("ai_agents");
  });

  it("gate 'allowlist' + contato autorizado → o guard não veta (avança no pipeline)", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub(
        { aiGate: "allowlist", aiAuthorizedAt: new Date().toISOString() },
        queried,
      ),
    );
    const result = await processMessageReceived(eventRow);
    expect(result.reason).not.toBe("nao_elegivel_para_ia");
    expect(queried).toContain("messages");
  });

  it("gate 'open' (default) → o guard não veta", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub({ aiGate: null, aiAuthorizedAt: null }, queried),
    );
    const result = await processMessageReceived(eventRow);
    expect(result.reason).not.toBe("nao_elegivel_para_ia");
    expect(queried).toContain("messages");
  });

  it("erro ao ler elegibilidade → skip 'nao_elegivel_para_ia' (fail-closed)", async () => {
    const queried: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      makeAdminStub(
        { aiGate: "allowlist", convError: "column contacts.ai_authorized_at does not exist" },
        queried,
      ),
    );
    const result = await processMessageReceived(eventRow);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("nao_elegivel_para_ia");
  });
});
