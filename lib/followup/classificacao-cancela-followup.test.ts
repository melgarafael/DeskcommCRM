/**
 * #4191, item 2 do mantenedor — O NEGÓCIO MARCADO NÃO É COBRADO, E O OUTRO
 * NEGÓCIO DO MESMO CONTATO CONTINUA SENDO.
 *
 * O defeito: `followup_enrollments` é por CONTATO (`contact_id`), e o motor
 * nunca perguntava ao negócio. Um card marcado como não comercial continuava
 * recebendo os passos do roteiro. A saída fácil — bloquear o contato — silencia
 * o outro negócio aberto da mesma pessoa, que é o caso que este arquivo mede.
 *
 * Três camadas, da mais pura à mais integrada:
 *
 *   A. `decidirSobreOFollowup`: a regra, com o contato de DOIS negócios;
 *   B. `exigirFollowupComercial`: a guarda, com um PostgREST falso que devolve
 *      por `lead_id` — a prova de que ela pergunta pelo NEGÓCIO;
 *   C. o motor: a guarda recusando vira `cancel_reason` que NOMEIA a
 *      classificação, e não "atendimento encerrado".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "./engine";
import {
  FollowupNaoComercialError,
  MOTIVO_DO_CANCELAMENTO_POR_CLASSIFICACAO,
  decidirSobreOFollowup,
  exigirFollowupComercial,
} from "./elegibilidade-do-negocio";
import type { FlowGraph } from "./graph-schema";
import type { EnrollmentEventRef, EnrollmentRow } from "./node-handlers";

// ─── A: a regra pura ─────────────────────────────────────────────────────────

describe("A. decidirSobreOFollowup — a unidade é o negócio, não o contato", () => {
  it("⭐ contato com DOIS negócios abertos: o classificado cala, o outro cobra", () => {
    // O mesmo `contact_id` nas duas inscrições — é o cerne do caso.
    const mesmoContato = "contato-1";
    const inscricaoDoNegocioA = { leadId: "negocio-A", contato: mesmoContato };
    const inscricaoDoNegocioB = { leadId: "negocio-B", contato: mesmoContato };

    const a = decidirSobreOFollowup({
      leadId: inscricaoDoNegocioA.leadId,
      naoComercialEm: "2026-11-18T10:00:00.000Z",
    });
    const b = decidirSobreOFollowup({
      leadId: inscricaoDoNegocioB.leadId,
      naoComercialEm: null,
    });

    expect(a).toEqual({
      acao: "cancelar",
      motivo: MOTIVO_DO_CANCELAMENTO_POR_CLASSIFICACAO,
    });
    expect(b).toEqual({ acao: "enviar", porque: "negocio_comercial" });
  });

  it("inscrição sem vínculo (legado) continua sendo cobrada — não se cala por falta de prova", () => {
    expect(decidirSobreOFollowup({ leadId: null, naoComercialEm: null })).toEqual({
      acao: "enviar",
      porque: "sem_vinculo",
    });
  });

  it("o motivo do cancelamento nomeia a classificação, não o atendimento", () => {
    const d = decidirSobreOFollowup({ leadId: "n-1", naoComercialEm: "2026-11-18T10:00:00.000Z" });
    expect(d.acao).toBe("cancelar");
    if (d.acao !== "cancelar") throw new Error("deveria cancelar");
    expect(d.motivo).toBe("Negócio classificado como não comercial");
    expect(d.motivo).not.toBe("Atendimento encerrado ou substituído");
  });
});

// ─── B: a guarda contra um PostgREST falso ───────────────────────────────────

type Linha = Record<string, unknown>;

/**
 * Um PostgREST mínimo: `from(tabela).select(cols).eq(col,val).eq(col,val).maybeSingle()`.
 * As linhas são indexadas por tabela e devolvidas SÓ quando todos os `eq` casam
 * — ou seja, a guarda só acha o negócio se perguntar por ele.
 */
function postgrest(tabelas: Record<string, Linha[]>) {
  const consultas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  function cliente(): SupabaseClient {
    let tabela = "";
    let filtros: Array<[string, unknown]> = [];
    const api = {
      from: (t: string) => {
        tabela = t;
        filtros = [];
        return api;
      },
      select: () => api,
      eq: (col: string, val: unknown) => {
        filtros.push([col, val]);
        return api;
      },
      maybeSingle: async () => {
        consultas.push({ tabela, filtros });
        const linha = (tabelas[tabela] ?? []).find((l) =>
          filtros.every(([c, v]) => (l[c] ?? null) === v),
        );
        return { data: linha ?? null, error: null };
      },
    };
    return api as unknown as SupabaseClient;
  }
  return { cliente, consultas };
}

const BOUNDARY: ServiceBoundary = {
  organization_id: "org-1",
  contact_id: "contato-1",
  conversation_id: "conv-1",
  demanda_id: "demanda-1",
  session_id: "sessao-1",
  revision: 3,
} as unknown as ServiceBoundary;

describe("B. exigirFollowupComercial — pergunta ao NEGÓCIO da inscrição", () => {
  it("negócio classificado: recusa o envio", async () => {
    const db = postgrest({
      crm_leads: [
        { id: "negocio-A", organization_id: "org-1", nao_comercial_em: "2026-11-18T10:00:00.000Z" },
        { id: "negocio-B", organization_id: "org-1", nao_comercial_em: null },
      ],
    });
    await expect(
      exigirFollowupComercial(db.cliente(), {
        organizationId: "org-1",
        enrollmentId: "enr-A",
        leadId: "negocio-A",
      }),
    ).rejects.toBeInstanceOf(FollowupNaoComercialError);
  });

  it("⭐ mesmo contato, negócio B comercial: o envio passa", async () => {
    const db = postgrest({
      crm_leads: [
        { id: "negocio-A", organization_id: "org-1", nao_comercial_em: "2026-11-18T10:00:00.000Z" },
        { id: "negocio-B", organization_id: "org-1", nao_comercial_em: null },
      ],
    });
    await expect(
      exigirFollowupComercial(db.cliente(), {
        organizationId: "org-1",
        enrollmentId: "enr-B",
        leadId: "negocio-B",
      }),
    ).resolves.toBeUndefined();
    // A leitura foi pelo id do NEGÓCIO B — não pelo contato.
    expect(db.consultas.at(-1)?.filtros).toContainEqual(["id", "negocio-B"]);
  });

  it("sem `lead_id` e sem demanda na fronteira: não pergunta nada e não cala", async () => {
    const db = postgrest({ crm_leads: [] });
    await expect(
      exigirFollowupComercial(db.cliente(), {
        organizationId: "org-1",
        enrollmentId: "enr-legado",
        leadId: null,
      }),
    ).resolves.toBeUndefined();
    expect(db.consultas).toEqual([]);
  });

  it("sem `lead_id`, mas com demanda na fronteira: o negócio da demanda decide", async () => {
    const db = postgrest({
      demandas: [{ id: "demanda-1", organization_id: "org-1", contact_id: "contato-1", lead_id: "negocio-A" }],
      crm_leads: [
        { id: "negocio-A", organization_id: "org-1", nao_comercial_em: "2026-11-18T10:00:00.000Z" },
      ],
    });
    await expect(
      exigirFollowupComercial(db.cliente(), {
        organizationId: "org-1",
        enrollmentId: "enr-sem-coluna",
        leadId: null,
        boundary: BOUNDARY,
      }),
    ).rejects.toBeInstanceOf(FollowupNaoComercialError);
  });

  it("demanda de OUTRO contato não empresta o negócio", async () => {
    const db = postgrest({
      demandas: [{ id: "demanda-1", organization_id: "org-1", contact_id: "outro", lead_id: "negocio-A" }],
      crm_leads: [
        { id: "negocio-A", organization_id: "org-1", nao_comercial_em: "2026-11-18T10:00:00.000Z" },
      ],
    });
    await expect(
      exigirFollowupComercial(db.cliente(), {
        organizationId: "org-1",
        enrollmentId: "enr-outro",
        leadId: null,
        boundary: BOUNDARY,
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── C: o motor ──────────────────────────────────────────────────────────────

const NOW = new Date("2026-11-19T18:01:00.000Z");
const DISPARO = "2026-11-19T18:00:01.000Z";

const GRAFO = {
  nodes: [
    { id: "trigger-1", type: "trigger", config: { kind: "manual" } },
    { id: "wait-3", type: "wait", config: { mode: "fixed", duration_ms: 86_400_000 } },
    { id: "action-4", type: "action", config: { mode: "text", body: "retome o contato" } },
    { id: "end-5", type: "end", config: { outcome: "exhausted" } },
  ],
  edges: [
    { id: "e1", source: "trigger-1", target: "wait-3", priority: 0, condition: { type: "always" } },
    { id: "e2", source: "wait-3", target: "action-4", priority: 0, condition: { type: "always" } },
    { id: "e3", source: "action-4", target: "end-5", priority: 0, condition: { type: "always" } },
  ],
} as unknown as FlowGraph;

function inscricao(over: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1",
    organization_id: "org-1",
    pointer_id: "ptr-1",
    version_id: "ver-1",
    contact_id: "contato-1",
    conversation_id: "conv-1",
    current_node_id: "wait-3",
    status: "active",
    next_eval_at: DISPARO,
    claimed_until: null,
    attempts: 0,
    max_attempts: 5,
    last_error: null,
    steps_taken: 3,
    outcome: null,
    cancel_reason: null,
    started_at: "2026-11-18T17:57:03.000Z",
    completed_at: null,
    updated_at: NOW.toISOString(),
    ...over,
  } as EnrollmentRow;
}

const EVENTOS: EnrollmentEventRef[] = [
  {
    node_id: "wait-3",
    idempotency_key: "wait-3:2",
    event_type: "wait_started",
    payload: { wake_status: "active", next_eval_at: DISPARO },
  },
];

function montarDb(recusa: () => void) {
  const patches: Array<Record<string, unknown>> = [];
  const db = {
    assertAgenda: vi.fn(async () => undefined),
    assertServiceBoundary: vi.fn(async () => recusa()),
    loadFlowGraph: vi.fn(async () => GRAFO),
    loadLeadFacts: vi.fn(async () => ({ lead_stage: null, tags: [] })),
    loadEnrollmentEvents: vi.fn(async () => EVENTOS),
    loadFlowPointerName: vi.fn(async () => "Fluxo de retomada"),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    updateEnrollment: vi.fn(async (_id: string, _org: string, patch: Record<string, unknown>) => {
      patches.push(patch);
    }),
    insertDeadInboxItem: vi.fn(async () => undefined),
  } as unknown as AdminClient;
  return { db, patches };
}

describe("C. o motor — a recusa por classificação vira o motivo certo", () => {
  it("⭐ cancel_reason nomeia a classificação, não o atendimento encerrado", async () => {
    const { db, patches } = montarDb(() => {
      throw new FollowupNaoComercialError();
    });
    const deps: TickDeps = { db, clock: () => NOW, enqueueJob: async () => {} };

    await avancarEnrollmentAtivo(deps, inscricao({ lead_id: "negocio-A" }));

    const cancelamento = patches.find((p) => p.status === "cancelled");
    expect(cancelamento?.cancel_reason).toBe("Negócio classificado como não comercial");
    expect(cancelamento?.cancel_reason).not.toBe("Atendimento encerrado ou substituído");
  });

  it("controle: a fronteira vencida continua com o motivo dela", async () => {
    const { db, patches } = montarDb(() => {
      throw new Error("stale");
    });
    const deps: TickDeps = { db, clock: () => NOW, enqueueJob: async () => {} };
    // Erro que NÃO é da família da fronteira: o motor o propaga para a camada de
    // tentativas, não cancela — é o comportamento de antes, e este caso garante
    // que a nova guarda não capturou o caminho genérico.
    await expect(avancarEnrollmentAtivo(deps, inscricao({ lead_id: "negocio-A" }))).rejects.toThrow(
      "stale",
    );
    expect(patches.some((p) => p.status === "cancelled")).toBe(false);
  });
});
