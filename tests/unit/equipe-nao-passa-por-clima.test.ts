/**
 * #3534 — CONTATO DA EQUIPE É ATENDIDO E MEDIDO; NÃO É PASSADO POR CLIMA.
 *
 * ─── O relato ───────────────────────────────────────────────────────────────
 *
 * Um sócio testa o agente pelo próprio número e cobra por texto ("por que você
 * não respondeu meus áudios? E se fosse um cliente?"). O prompt do agente manda
 * falar com ele como colega, e isso funciona NO TURNO. O medidor de clima roda
 * ANTES, não sabe quem é da equipe, lê a cobrança como cliente irritado e:
 *
 *   1. emite `ai.sentiment_alert` → `triggerHandoff('low_sentiment')`;
 *   2. a conversa vira `status='pending'`, `bot_silenced_until='infinity'`;
 *   3. o dono da empresa recebe "já acionei o time", sendo ele o time.
 *
 * ─── O que este arquivo prende ──────────────────────────────────────────────
 *
 * A régua de "quem é equipe" é a que o mantenedor escolheu no #3534: uma lista
 * SEPARADA em `organizations.settings.crm.team_contact_tags`, lida por
 * `lib/contacts/tags-da-equipe.ts` com a MESMA normalização das etiquetas
 * internas (`normalizarTags`). Ela significa "continua sendo atendido, sem
 * repasse automático" — o oposto do `internal_contact_tags`, que veta a IA.
 *
 * Medido com as funções de produção, cada uma no seu caminho:
 *
 *   - `processSentiment`  → mede e registra, NÃO emite alerta (não paga handoff);
 *   - `triggerHandoff`    → recusa `low_sentiment`, então NÃO silencia a conversa
 *                           (é o dano que dói mais: `bot_silenced_until`);
 *   - `decidirElegibilidade` → a etiqueta não veta nem autoriza: o contato da
 *                           equipe segue a régua do canal (preso em
 *                           `equipe-nao-e-silenciada-pelo-clima.test.ts`).
 *
 * O CONTROLE está em todos os três: o MESMO texto, na MESMA organização, num
 * telefone sem a etiqueta, continua sendo medido, passado e silenciado. Sem ele,
 * "não passa" se provaria com um medidor que não mede ninguém.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  OPENROUTER_API_KEY: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/log-invocation", () => ({ logInvocation: vi.fn() }));
vi.mock("@/lib/ai/cost", () => ({ computeCost: vi.fn(async () => 1) }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));

const avisarLeadDoCrm = vi.fn(async (..._a: unknown[]) => ({ avisado: true }));
vi.mock("@/lib/ai/handoff/aviso-ao-lead", () => ({
  avisarLeadDoCrm: (...a: unknown[]) => avisarLeadDoCrm(...a),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => false }));

import { generateObject } from "ai";

import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSentiment } from "@/workers/ai-sentiment-worker";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const AGENTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSAO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTATO = "55555555-5555-4555-8555-555555555555";

/** O texto do relato, literal. */
const TEXTO_DO_SOCIO =
  "por que você não respondeu meus áudios? E se fosse um cliente? Eu iria ficar sem resposta?";
/** Abaixo do limiar padrão (0,3): numa conversa elegível, o alerta sai. */
const NOTA_IRRITADA = 0.1;

type Linha = Record<string, unknown>;

function fazerAdmin(banco: Record<string, Linha[]>, rpcs: Linha[], updates: Linha[]) {
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    const linhas = () => (banco[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = new Proxy(
      {},
      {
        get: (_alvo, prop: string) => {
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: linhas()[0] ?? null, error: null });
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
              Promise.resolve({ data: linhas(), error: null }).then(ok, falha);
          }
          return (...args: unknown[]) => {
            if (prop === "eq") filtros.push((l) => l[args[0] as string] === args[1]);
            if (prop === "is") filtros.push((l) => (l[args[0] as string] ?? null) === args[1]);
            if (prop === "update") updates.push({ tabela, payload: args[0] });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return {
    from,
    rpc: (nome: string, args: Linha) => {
      rpcs.push({ nome, ...args });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

/**
 * Um telefone só. A ÚNICA coisa que muda entre os dois casos é a etiqueta do
 * contato — mesmo texto, mesma organização, mesmas listas, mesma versão.
 */
function cenario(tagsDoContato: string[]) {
  const msg = "22222222-2222-4222-8222-222222222222";
  const conv = "33333333-3333-4333-8333-333333333333";
  const settings = { crm: { team_contact_tags: ["socio"], internal_contact_tags: [] } };
  const banco: Record<string, Linha[]> = {
    organizations: [{ id: ORG, settings, locale: "pt-BR" }],
    messages: [
      {
        id: msg,
        organization_id: ORG,
        conversation_id: conv,
        body: TEXTO_DO_SOCIO,
        direction: "inbound",
        metadata: {},
      },
    ],
    conversations: [
      {
        id: conv,
        organization_id: ORG,
        channel_session_id: SESSAO,
        active_ai_agent_id: null,
        contact_id: CONTATO,
        is_group: false,
        assignee_kind: "ai",
        bot_silenced_until: null,
        organizations: { status: "active", settings },
        contacts: {
          force_human: false,
          ai_opt_out: false,
          ai_authorized_at: null,
          phone_number: "+551****7777",
          tags: tagsDoContato,
        },
        channel_sessions: { metadata: {} },
      },
    ],
    ai_agents: [
      {
        id: AGENTE,
        organization_id: ORG,
        config: {},
        kind: "mcp_agent",
        is_active: true,
        priority: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        published_version_id: VERSAO,
        archived_at: null,
        paused_at: null,
      },
    ],
    ai_agent_versions: [
      {
        id: VERSAO,
        organization_id: ORG,
        agent_id: AGENTE,
        channel_session_id: SESSAO,
        status: "published",
      },
    ],
  };
  const evento = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    organization_id: ORG,
    entity_id: msg,
    payload: { message_id: msg, conversation_id: conv },
  } as unknown as EventRow;
  return { banco, evento, msg };
}

async function medir(tagsDoContato: string[]) {
  const { banco, evento, msg } = cenario(tagsDoContato);
  const rpcs: Linha[] = [];
  const updates: Linha[] = [];
  vi.mocked(createAdminClient).mockReturnValue(
    fazerAdmin(banco, rpcs, updates) as unknown as ReturnType<typeof createAdminClient>,
  );
  const resultado = await processSentiment(evento);
  const metadados = updates.find((u) => u["tabela"] === "messages")?.["payload"] as
    | { metadata?: Linha }
    | undefined;
  return {
    resultado,
    alertas: rpcs.filter((r) => r["p_event_type"] === "ai.sentiment_alert"),
    notaGravada: metadados?.metadata?.["sentiment_score"] ?? null,
    msg,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolverModeloDoPonto).mockResolvedValue({
    model: "modelo-dublê",
    modelId: "anthropic/claude-haiku-4-5",
  } as unknown as Awaited<ReturnType<typeof resolverModeloDoPonto>>);
  vi.mocked(generateObject).mockResolvedValue({
    object: { sentiment_score: NOTA_IRRITADA, reasoning_short: "irritado com o atendimento" },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as unknown as Awaited<ReturnType<typeof generateObject>>);
});

describe("medidor de clima · telefone da equipe (#3534)", () => {
  it("EQUIPE: é medido e registrado, mas NÃO emite alerta — não há repasse por clima", async () => {
    const r = await medir(["socio"]);

    // Medido e registrado: a nota entra em `messages.metadata`, como para
    // qualquer cliente. É o que o mantenedor pediu ("medido e registrado").
    expect(r.resultado).toMatchObject({ skipped: false, sentiment_score: NOTA_IRRITADA });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(r.notaGravada).toBe(NOTA_IRRITADA);

    // E não abre passagem: sem `ai.sentiment_alert`, não há handoff nem silêncio.
    expect(r.alertas, "o sócio foi passado a uma pessoa e o agente calado").toHaveLength(0);
  });

  it("CONTROLE: o MESMO texto, num telefone fora da lista, continua sendo passado", async () => {
    const r = await medir([]);

    expect(r.resultado).toMatchObject({ skipped: false, sentiment_score: NOTA_IRRITADA });
    expect(r.notaGravada).toBe(NOTA_IRRITADA);
    expect(r.alertas, "o cliente irritado deixou de chamar uma pessoa").toHaveLength(1);
    expect(r.alertas[0]?.["p_payload"]).toMatchObject({
      message_id: r.msg,
      sentiment_score: NOTA_IRRITADA,
    });
  });
});
