/**
 * #4340 (segunda metade) — O TURNO NO NÚMERO NOVO ENCONTRA O ROTEADOR.
 *
 * O defeito fechado aqui não é de tela nem de auditoria: é o turno. Com o
 * roteador preso no número antigo, a mensagem que chega no número NOVO é
 * resolvida por `resolveTurnAgent` com `router === null` — cai no agente
 * principal, sem decisão de intenção. Este teste costura as duas metades:
 *
 *   1. o operador move o roteador com a ação da tela (`moverRoteadorParaNumero`
 *      — a mesma função que o PATCH chama);
 *   2. o `loadActiveRouter` DE VERDADE (o SQL de produção) roda contra o banco
 *      com o estado que a mudança deixou;
 *   3. o `resolveTurnAgent` DE VERDADE resolve o turno da sessão nova.
 *
 * Antes da mudança, o mesmo turno na sessão nova devolve `no_router` (controle
 * negativo: prova que o teste consegue reprovar). Depois, devolve `classified`
 * com o `routerId` e o agente da intenção.
 */
import { describe, expect, it, vi } from "vitest";

import { moverRoteadorParaNumero } from "@/lib/ai/agents/mover-roteador-de-numero";

import type { PublishedAgentConfig } from "./agent-config";
import { resolveTurnAgent } from "./resolve-turn-agent";
import { loadActiveRouter } from "./router-config";

const ORG = "11111111-1111-4111-8111-111111111111";
const ROUTER = "22222222-2222-4222-8222-222222222222";
const NUMERO_ANTIGO = "33333333-3333-4333-8333-333333333333";
const NUMERO_NOVO = "44444444-4444-4444-8444-444444444444";
const AGENTE_VENDAS = "55555555-5555-4555-8555-555555555555";

/** Estado do banco no recorte que a mudança e a leitura do turno usam. */
function bancoDoTeste() {
  const estado = {
    router: {
      id: ROUTER,
      organization_id: ORG,
      name: "Roteador do atendimento",
      channel_session_id: NUMERO_ANTIGO,
      is_active: true,
      config: { sticky: false, min_confidence: 0.6 },
      fallback_agent_id: null,
    },
    canais: [
      { id: NUMERO_ANTIGO, organization_id: ORG, archived_at: "2026-11-01T12:00:00.000Z" },
      { id: NUMERO_NOVO, organization_id: ORG, archived_at: null },
    ],
    membros: [
      {
        agent_id: AGENTE_VENDAS,
        intent_name: "vendas",
        intent_description: "quer comprar",
        examples: [] as string[],
        flow_pointer_id: null,
        pipeline_id: null,
        stage_id: null,
        agent_name: "Vendas",
        trigger_config: null,
      },
    ],
  };

  /** PostgREST falso: só o que `moverRoteadorParaNumero` consulta. */
  const supabase = {
    from(tabela: string) {
      let pediuArquivado = false;
      let pediuSomenteId = false;
      const filtros: Array<[string, unknown]> = [];
      const resolver = () => {
        if (tabela === "ai_routers") {
          return pediuSomenteId
            ? { data: [] as unknown[], error: null }
            : { data: estado.router, error: null };
        }
        const id = filtros.find(([c]) => c === "id")?.[1];
        const canal = estado.canais.find((c) => c.id === id) ?? null;
        if (!canal) return { data: null, error: null };
        return { data: pediuArquivado ? canal : { id: canal.id }, error: null };
      };
      const q = {
        select(colunas: string) {
          pediuArquivado = colunas.includes("archived_at");
          pediuSomenteId = colunas.trim() === "id";
          return q;
        },
        eq(coluna: string, valor: unknown) {
          filtros.push([coluna, valor]);
          return q;
        },
        limit: () => Promise.resolve(resolver()),
        maybeSingle: () => Promise.resolve(resolver()),
        update(valores: Record<string, unknown>) {
          estado.router = { ...estado.router, ...valores };
          return {
            eq() {
              return this;
            },
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(resolve),
          };
        },
      };
      return q;
    },
  };

  /** `pg.Pool` falso com o mesmo recorte de SQL que `loadActiveRouter` usa. */
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from ai_routers")) {
        const [org, sessao] = params ?? [];
        if (
          estado.router.organization_id !== org ||
          estado.router.channel_session_id !== sessao ||
          !estado.router.is_active
        ) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: estado.router.id,
              name: estado.router.name,
              config: estado.router.config,
              fallback_agent_id: estado.router.fallback_agent_id,
            },
          ],
        };
      }
      if (sql.includes("from ai_router_members")) {
        return { rows: estado.membros };
      }
      return { rows: [] };
    }),
  };

  return { estado, supabase: supabase as never, pool };
}

function configDoAgente(): PublishedAgentConfig {
  return {
    agentId: AGENTE_VENDAS,
    versionId: "v-vendas",
    agentName: "Vendas",
    systemPrompt: "prompt",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    credentialId: null,
    maxSteps: 5,
    historyMessageWindow: 20,
    historyTokenWindow: 4000,
    handoffKeywords: [],
    handoffToolEnabled: false,
    proposalAiDraftEnabled: true,
    splitMessages: false,
    splitMaxChars: 900,
    inboundDebounceMs: null,
    replyMinIntervalMs: null,
    multimodalInput: false,
    casesEnabled: false,
    toolIds: [],
    knowledgeSourceIds: [],
    skillNames: null,
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.72,
    janelaDeAtendimento: null,
    versionCreatedBy: null,
    operatorEnabled: false,
    operatorModel: null,
    operatorToolIds: [],
    pipelineIds: [],
    agentCreatedBy: null,
    vozEnabled: false,
    vozQuando: "espelhar",
  };
}

/** O turno de uma mensagem que chegou no número — com o SQL real do roteador. */
async function turnoNoNumero(pool: unknown, channelSessionId: string) {
  return resolveTurnAgent(
    pool as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    {
      tenantId: ORG,
      leadId: "contato-1",
      jobId: "job-1",
      channelSessionId,
      conversationId: "conversa-1",
      signal: "quanto custa o plano?",
      stickyAgentId: null,
      stickyIntent: null,
    },
    {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      loadActiveRouter: (db: never, org: string, sessao: string) =>
        loadActiveRouter(db, org, sessao),
      loadPublishedAgentConfigById: vi.fn(async () => configDoAgente()),
      loadPublishedAgentConfig: vi.fn(async () => configDoAgente()),
      classifyIntent: vi.fn(async () => ({ intentName: "vendas", confidence: 0.92 })),
      carregarFatosDoCrmDoContato: vi.fn(async () => ({
        fatos: { funis: [], etiquetas: [], funisOmitidos: 0, etiquetasOmitidas: 0 },
        motivo: null,
      })),
      consultarJev: vi.fn(() => ({
        estado: Promise.resolve("desligada" as const),
        escolha: Promise.resolve(null),
        modo: Promise.resolve("comparacao" as const),
        observar: vi.fn(),
      })),
      temIaDeSempre: vi.fn(async () => true),
    } as never,
  );
}

describe("#4340 — o turno acompanha o roteador até o número novo", () => {
  it("controle negativo: antes da mudança, o número novo não acha roteador nenhum", async () => {
    const banco = bancoDoTeste();

    const antes = await turnoNoNumero(banco.pool, NUMERO_NOVO);

    expect(antes.routerId, "o número novo achou um roteador antes de existir um").toBeNull();
    expect(antes.outcome).toBe("no_router");
  });

  it("depois de mover, o turno no número novo classifica a intenção pelo roteador movido", async () => {
    const banco = bancoDoTeste();

    const mudanca = await moverRoteadorParaNumero(banco.supabase, {
      organizationId: ORG,
      routerId: ROUTER,
      novoChannelSessionId: NUMERO_NOVO,
      quemMoveu: { userId: null, apiTokenId: null, requestId: "req-1" },
    });
    expect(mudanca).toMatchObject({ ok: true, de: NUMERO_ANTIGO, para: NUMERO_NOVO });

    const depois = await turnoNoNumero(banco.pool, NUMERO_NOVO);

    expect(depois.outcome, "o turno no número novo não foi classificado").toBe("classified");
    expect(depois.routerId).toBe(ROUTER);
    expect(depois.intentName).toBe("vendas");
    expect(depois.config?.agentId, "o turno não foi para o agente da intenção").toBe(AGENTE_VENDAS);

    // A leitura do turno perguntou pela sessão NOVA — não é cache nem acaso.
    const leituras = banco.pool.query.mock.calls
      .filter(([sql]) => sql.includes("from ai_routers"))
      .map(([, params]) => params?.[1]);
    expect(leituras).toContain(NUMERO_NOVO);
  });

  it("o número antigo, arquivado, deixa de decidir — o roteador não fica nos dois", async () => {
    const banco = bancoDoTeste();

    await moverRoteadorParaNumero(banco.supabase, {
      organizationId: ORG,
      routerId: ROUTER,
      novoChannelSessionId: NUMERO_NOVO,
      quemMoveu: { userId: null, apiTokenId: null, requestId: "req-1" },
    });

    const antigo = await turnoNoNumero(banco.pool, NUMERO_ANTIGO);

    expect(antigo.outcome).toBe("no_router");
    expect(antigo.routerId).toBeNull();
  });
});
