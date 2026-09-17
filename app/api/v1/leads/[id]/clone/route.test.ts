import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => "api"),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => ({ source: "user", reason: "clone_cross_pipeline" }),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const P1 = "44444444-4444-4444-8444-444444444444";
const P2 = "55555555-5555-4555-8555-555555555555";
const S1_A = "66666666-6666-4666-8666-666666666666";
const S1_LOST = "77777777-7777-4777-8777-777777777777";
const S2_A = "88888888-8888-4888-8888-888888888888";
const S2_B = "99999999-9999-4999-8999-999999999999";
const S2_LOST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

/**
 * Fake mínimo do client Supabase: só o que os caminhos exercitados usam —
 * select/eq/order/limit + maybeSingle/single, insert e update com filtros.
 */
function fakeDb(seed: Record<string, Row[]>) {
  const tables = seed;

  function from(table: string) {
    const filters: [string, unknown][] = [];
    const orders: [string, boolean][] = [];
    let limit = Number.POSITIVE_INFINITY;
    let operation: "select" | "insert" | "update" = "select";
    let patch: Row | null = null;
    let pending: Row | null = null;

    const rows = (): Row[] => (tables[table] ??= []);
    const matches = () => rows().filter((row) => filters.every(([c, v]) => row[c] === v));

    function selectRows(): Row[] {
      return matches()
        .sort((a, b) => {
          for (const [column, ascending] of orders) {
            const diff = Number(a[column] ?? 0) - Number(b[column] ?? 0);
            if (diff !== 0) return ascending ? diff : -diff;
          }
          return 0;
        })
        .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
    }

    function resolveOne(required: boolean) {
      if (operation === "insert" && pending) {
        rows().push(pending);
        return { data: pending, error: null };
      }
      if (operation === "update" && patch) {
        let updated: Row | null = null;
        for (const row of matches()) {
          Object.assign(row, patch);
          // O banco fecha pelo trigger `fn_crm_lead_close_on_stage`: quem manda o
          // desfecho é a ETAPA, não um campo `status` no patch.
          const etapa = (tables.crm_stages ?? []).find((candidate) => candidate.id === row.stage_id);
          if (etapa?.is_won === true) {
            row.status = "won";
            row.closed_at ??= "2026-09-15T10:05:00.000Z";
          } else if (etapa?.is_lost === true) {
            row.status = "lost";
            row.closed_at ??= "2026-09-15T10:05:00.000Z";
          }
          updated = row;
        }
        if (!updated) return { data: null, error: null };
        return { data: updated, error: null };
      }
      const row = selectRows()[0] ?? null;
      if (!row && required) return { data: null, error: { message: "row not found" } };
      return { data: row, error: null };
    }

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push([column, options?.ascending ?? true]);
        return builder;
      },
      limit: (value: number) => {
        limit = value;
        return builder;
      },
      insert: (row: Row) => {
        operation = "insert";
        pending = { id: `novo-${rows().length + 1}`, ...row };
        return builder;
      },
      update: (value: Row) => {
        operation = "update";
        patch = value;
        return builder;
      },
      maybeSingle: async () => resolveOne(false),
      single: async () => resolveOne(true),
      // `await` direto no builder é select de LISTA — e é assim que `encerraDemanda`
      // aplica o update (sem `.select()`), então o update precisa valer aqui também.
      then: async (resolve: (value: unknown) => unknown) =>
        resolve(
          operation === "select" ? { data: selectRows(), error: null } : resolveOne(false),
        ),
    };

    return builder;
  }

  return { client: { from } as never, tables };
}

function seed() {
  return {
    crm_pipelines: [
      { id: P1, organization_id: ORG_ID, name: "Comercial" },
      { id: P2, organization_id: ORG_ID, name: "Suporte" },
    ],
    crm_stages: [
      { id: S1_A, organization_id: ORG_ID, pipeline_id: P1, name: "Novo", position: 1000, is_won: false, is_lost: false, is_archived: false },
      { id: S1_LOST, organization_id: ORG_ID, pipeline_id: P1, name: "Perdido", position: 9000, is_won: false, is_lost: true, is_archived: false },
      { id: S2_A, organization_id: ORG_ID, pipeline_id: P2, name: "Triagem", position: 1000, is_won: false, is_lost: false, is_archived: false },
      { id: S2_B, organization_id: ORG_ID, pipeline_id: P2, name: "Em análise", position: 2000, is_won: false, is_lost: false, is_archived: false },
      { id: S2_LOST, organization_id: ORG_ID, pipeline_id: P2, name: "Perdido", position: 9000, is_won: false, is_lost: true, is_archived: false },
    ],
    crm_leads: [
      {
        id: LEAD_ID,
        organization_id: ORG_ID,
        pipeline_id: P1,
        stage_id: S1_A,
        status: "open",
        position_in_stage: 1000,
        title: "Orçamento da loja",
        description: "Cliente quer trocar o piso",
        contact_id: null,
        value_cents: 150000,
        currency: "BRL",
        owner_user_id: null,
        owner_agent_id: null,
        owner_kind: null,
        expected_close_date: null,
        tags: ["piso"],
        source: "manual",
        source_metadata: { canal: "whatsapp" },
        custom_fields: {},
        external_id: "pedido-8821",
        lost_reason: null,
        closed_at: null,
        updated_at: "2026-09-15T10:00:00.000Z",
      },
    ],
  } as Record<string, Row[]>;
}

let db: ReturnType<typeof fakeDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = fakeDb(seed());
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue(db.client);
});

function cloneRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/clone`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function moveRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/move`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = { params: Promise.resolve({ id: LEAD_ID }) };

describe("POST /api/v1/leads/[id]/clone", () => {
  it("cria o negócio no funil destino e fecha a origem como perdida", async () => {
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P2 }), params);
    const body = await response.json();

    expect(response.status).toBe(201);
    const clone = body.data.lead as Row;
    expect(clone.pipeline_id).toBe(P2);
    expect(clone.stage_id).toBe(S2_A);
    expect(clone.title).toBe("Orçamento da loja");
    expect(clone.value_cents).toBe(150000);
    expect(clone.status).toBe("open");
    // `external_id` identifica o pedido de ORIGEM: repetir o valor colidiria com
    // uniq_crm_leads_org_source_external e derrubaria o clone.
    expect(clone.external_id).toBeNull();

    const origem = (db.tables.crm_leads ?? []).find((row) => row.id === LEAD_ID) as Row;
    expect(origem.status).toBe("lost");
    expect(origem.stage_id).toBe(S1_LOST);
    expect(origem.pipeline_id).toBe(P1);
    expect(origem.lost_reason).toBe("other");
    expect((origem.source_metadata as Row).movido_para).toMatchObject({
      lead_id: clone.id,
      pipeline_id: P2,
      stage_id: S2_A,
    });
    expect((origem.source_metadata as Row).canal).toBe("whatsapp");
  });

  it("cada lado conta a troca na LINHA DO TEMPO — e a origem não diz 'Perdido — other'", async () => {
    // `source_metadata` guarda os ponteiros, mas nenhuma tela o lê: a linha do
    // tempo do dossiê vem de `crm_lead_activities`. Sem estas duas linhas, o
    // negócio novo aparecia no funil de destino sem história nenhuma, e a origem
    // dizia "Demanda encerrada — Perdido — other" para um negócio que não se
    // perdeu: quem abrisse o card leria uma perda que não aconteceu.
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P2 }), params);
    const body = await response.json();
    expect(response.status).toBe(201);
    const cloneId = (body.data.lead as Row).id;

    const linhas = vi.mocked(emitLeadActivity).mock.calls.map(([, entrada]) => entrada);
    expect(linhas).toContainEqual(
      expect.objectContaining({
        leadId: cloneId,
        type: "moved_from_pipeline",
        reason: "Veio do funil Comercial",
        payload: { from_pipeline_id: P1, from_lead_id: LEAD_ID },
      }),
    );
    expect(linhas).toContainEqual(
      expect.objectContaining({
        leadId: LEAD_ID,
        type: "demand_closed",
        reason: "Levado para o funil Suporte",
        payload: expect.objectContaining({ to_pipeline_id: P2, to_lead_id: cloneId }),
      }),
    );
    expect(linhas.map((l) => l.reason)).not.toContain("Perdido — other");
  });

  it("aceita a etapa destino informada pelo cliente", async () => {
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P2, stage_id: S2_B }), params);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect((body.data.lead as Row).stage_id).toBe(S2_B);
  });

  it("motivo fora do vocabulário do funil: 422 e NENHUMA escrita", async () => {
    // A recusa vinha do trigger, no encerramento da ORIGEM — que roda DEPOIS de o
    // clone já existir. O operador recebia 500 com o negócio duplicado no destino
    // e a origem ainda aberta; a pergunta agora é feita antes da primeira escrita.
    const antes = (db.tables.crm_leads ?? []).length;
    const { POST } = await import("./route");

    const response = await POST(
      cloneRequest({ pipeline_id: P2, lost_reason: "mudou de funil" }),
      params,
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("lost_reason_invalid");
    expect((db.tables.crm_leads ?? []).length).toBe(antes);
    const origem = (db.tables.crm_leads ?? []).find((row) => row.id === LEAD_ID) as Row;
    expect(origem.status).toBe("open");
  });

  it("motivo ESTENDIDO pelo funil de origem passa", async () => {
    const base = seed();
    db = fakeDb({
      ...base,
      crm_pipelines: (base.crm_pipelines ?? []).map((funil) =>
        funil.id === P1 ? { ...funil, settings: { lost_reasons: ["mudou de funil"] } } : funil,
      ),
    });
    vi.mocked(createClient).mockResolvedValue(db.client);
    const { POST } = await import("./route");

    const response = await POST(
      cloneRequest({ pipeline_id: P2, lost_reason: "mudou de funil" }),
      params,
    );

    expect(response.status).toBe(201);
    const origem = (db.tables.crm_leads ?? []).find((row) => row.id === LEAD_ID) as Row;
    expect(origem.lost_reason).toBe("mudou de funil");
  });

  it("usa o motivo de perda informado quando ele é canônico", async () => {
    const { POST } = await import("./route");

    await POST(cloneRequest({ pipeline_id: P2, lost_reason: "price" }), params);

    const origem = (db.tables.crm_leads ?? []).find((row) => row.id === LEAD_ID) as Row;
    expect(origem.lost_reason).toBe("price");
  });

  it("recusa troca para o mesmo funil (o caminho é o /move)", async () => {
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P1 }), params);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("pipeline_unchanged");
  });

  it("recusa etapa que não pertence ao funil destino", async () => {
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P2, stage_id: S1_A }), params);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("stage_pipeline_mismatch");
  });

  it("recusa negócio já encerrado", async () => {
    const { POST } = await import("./route");
    const negocio = (db.tables.crm_leads ?? [])[0];
    if (!negocio) throw new Error("o teste espera um crm_leads semeado neste ponto");
    negocio.status = "won";

    const response = await POST(cloneRequest({ pipeline_id: P2 }), params);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("lead_not_open");
  });

  it("recusa funil inexistente na organização", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      cloneRequest({ pipeline_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      params,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("pipeline_not_found");
  });

  it("recusa etapa de destino terminal (o clone nasceria fechado)", async () => {
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P2, stage_id: S2_LOST }), params);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("stage_destino_terminal");
  });

  it("recusa funil de destino sem etapa aberta para receber o negócio", async () => {
    db = fakeDb({
      ...seed(),
      crm_stages: (seed().crm_stages ?? []).filter((row) => row.id !== S2_A && row.id !== S2_B),
    });
    vi.mocked(createClient).mockResolvedValue(db.client);
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P2 }), params);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("pipeline_without_initial_stage");
  });

  it("recusa ANTES de criar o clone quando o funil de origem não tem etapa de perda", async () => {
    // A recusa de `encerraDemanda` (422 `pipeline_no_lost_stage`) acontecia
    // DEPOIS da criação: o operador lia "nada mudou" com o negócio já duplicado
    // no destino. A pergunta passa a ser feita antes, e o que se prova aqui é o
    // ESTADO — nenhum clone no banco —, não só o código do erro.
    db = fakeDb({
      ...seed(),
      crm_stages: (seed().crm_stages ?? []).filter((row) => row.id !== S1_LOST),
    });
    vi.mocked(createClient).mockResolvedValue(db.client);
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P2 }), params);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("pipeline_no_lost_stage");
    expect(db.tables.crm_leads).toHaveLength(1);
    expect((db.tables.crm_leads ?? [])[0]?.status).toBe("open");
  });

  it("o clone leva os campos personalizados INTEIROS, inclusive os que o destino não declara", async () => {
    // `custom_fields` não é só o que a tela do funil mostra: a automação entrega
    // o jsonb cru à IA (lib/automation/dados-do-formulario.ts) e ao webhook de
    // saída (lib/automation/actions/call-webhook.ts). O formulário que caiu num
    // campo nunca declarado é o caso COMUM — e o funil de destino sem campo
    // declarado nenhum é o caso comum também. Filtrar pelo destino apagava do
    // negócio novo tudo o que o assistente sabia do cliente.
    const base = seed();
    const origem = (base.crm_leads ?? [])[0];
    if (!origem) throw new Error("o teste espera um crm_leads semeado neste ponto");
    origem.custom_fields = { metragem: "120m2", numero_da_os: "OS-99" };
    db = fakeDb({
      ...base,
      crm_pipelines: (base.crm_pipelines ?? []).map((funil) =>
        funil.id === P2
          ? { ...funil, settings: { fields: [{ key: "metragem", label: "Metragem", type: "text" }] } }
          : funil,
      ),
    });
    vi.mocked(createClient).mockResolvedValue(db.client);
    const { POST } = await import("./route");

    const response = await POST(cloneRequest({ pipeline_id: P2 }), params);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect((body.data.lead as Row).custom_fields).toEqual({
      metragem: "120m2",
      numero_da_os: "OS-99",
    });
  });
});

describe("POST /api/v1/leads/[id]/move cross-pipeline", () => {
  it("aponta o endpoint de clone no 422 (o clone que a P-01 mandava usar não existia)", async () => {
    const { POST } = await import("../move/route");

    const response = await POST(
      moveRequest({
        stage_id: S2_A,
        position_in_stage: 1000,
        expected_updated_at: "2026-09-15T10:00:00.000Z",
      }),
      params,
    );
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("pipeline_immutable_use_clone");
    expect(body.error.details).toMatchObject({ use: "/api/v1/leads/{id}/clone" });
  });
});
