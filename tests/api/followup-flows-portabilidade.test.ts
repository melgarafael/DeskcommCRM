/**
 * Exportar/importar fluxo — as ROTAS reais (`[id]/export` e `import`), com auth
 * e Supabase simulados no padrão de `tests/api/followup-flows.test.ts`.
 *
 * O que só a rota prova: papel exigido, isolamento por organização (exportar o
 * fluxo de outra conta = 404; o remapeamento nunca casa com a etapa de outra
 * conta), o fluxo importado nascer `draft` sem versão, nome livre, auditoria e
 * a recusa de arquivo inválido COM a lista de problemas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { fail } from "@/lib/api/wrappers";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import type { FlowGraph } from "@/lib/followup/graph-schema";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/modulos", async (original) => ({
  ...(await original<typeof import("@/lib/instalacao/modulos")>()),
  moduloLigado: vi.fn(async () => true),
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "22222222-2222-4222-8222-999999999999";
const PIPE = "33333333-3333-4333-8333-333333333333";
const PIPE_OUTRA = "33333333-3333-4333-8333-999999999999";
const ETAPA_AQUI = "44444444-4444-4444-8444-444444444444";
const ETAPA_OUTRA = "44444444-4444-4444-8444-999999999999";

type Row = Record<string, unknown>;

const pos = { x: 0, y: 0 };
function grafoQueMove(stageId: string): FlowGraph {
  return {
    nodes: [
      { id: "t1", type: "trigger", label: "Início", position: pos, config: {} },
      { id: "m1", type: "move_lead", label: "Mover", position: pos, config: { stage_id: stageId } },
      { id: "e1", type: "end", label: "Fim", position: pos, config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "x1", source: "t1", target: "m1", priority: 0, condition: { type: "always" } },
      { id: "x2", source: "m1", target: "e1", priority: 0, condition: { type: "always" } },
    ],
  };
}

function makeDb(tables: Record<string, Row[]>) {
  const all: Record<string, Row[]> = {
    followup_flow_pointers: [],
    followup_flow_versions: [],
    crm_stages: [],
    crm_pipelines: [],
    message_templates: [],
    meta_templates: [],
    user_organizations: [],
    calendar_event_types: [],
    ...tables,
  };
  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let mode: "select" | "insert" = "select";
    let payload: Row | undefined;
    const matches = (row: Row) =>
      filters.every(([k, v]) => (v instanceof Set ? v.has(row[k]) : (row[k] ?? false) === v));
    function execute(): { data: Row[] | null; error: { code?: string; message: string } | null } {
      const rows = all[table];
      if (!rows) return { data: null, error: { message: `tabela desconhecida: ${table}` } };
      if (mode === "select") return { data: rows.filter(matches), error: null };
      const row: Row = {
        id: randomUUID(),
        active_version_id: null,
        updated_at: new Date().toISOString(),
        ...payload,
      };
      if (rows.some((r) => r.organization_id === row.organization_id && r.name === row.name)) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      rows.push(row);
      return { data: [row], error: null };
    }
    const b = {
      select: () => b,
      insert(obj: Row) {
        mode = "insert";
        payload = obj;
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return b;
      },
      in(col: string, vals: unknown[]) {
        filters.push([col, new Set(vals)]);
        return b;
      },
      async maybeSingle() {
        const r = execute();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      async single() {
        const r = execute();
        return r.error
          ? { data: null, error: r.error }
          : { data: r.data?.[0] ?? null, error: null };
      },
      then(onF: (v: ReturnType<typeof execute>) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve(execute()).then(onF, onR);
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table), tables: all };
}

function session(role: Role, db: ReturnType<typeof makeDb>) {
  const user: AuthUser = {
    id: USER_ID,
    email: "m@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[role] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG_ID, name: "Org", role } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(db as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createAdminClient).mockReturnValue(db as any);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const getReq = () => new NextRequest("http://localhost/api/v1/ai/followup-flows/x/export");
const postReq = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/ai/followup-flows/import", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moduloLigado).mockResolvedValue(true);
});

describe("GET /api/v1/ai/followup-flows/:id/export", () => {
  it("devolve o arquivo com o nome da etapa citada", async () => {
    const id = randomUUID();
    const db = makeDb({
      followup_flow_pointers: [
        {
          id,
          organization_id: ORG_ID,
          name: "Mover para proposta",
          draft_graph: grafoQueMove(ETAPA_AQUI),
          trigger_config: { kind: "manual" },
          handoff_policy: "cancel",
          surface: "followup",
          active_version_id: null,
        },
      ],
      crm_stages: [
        {
          id: ETAPA_AQUI,
          organization_id: ORG_ID,
          name: "Proposta",
          pipeline_id: PIPE,
          is_archived: false,
        },
      ],
      crm_pipelines: [{ id: PIPE, organization_id: ORG_ID, name: "Vendas" }],
    });
    session("viewer", db);
    const { GET } = await import("@/app/api/v1/ai/followup-flows/[id]/export/route");
    const res = await GET(getReq(), ctx(id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { file_name: string; file: Row } };
    expect(body.data.file_name).toBe("mover-para-proposta.fluxo.json");
    expect(body.data.file).toMatchObject({
      format: "followup_flow",
      version: 1,
      flow: {
        name: "Mover para proposta",
        handoff_policy: "cancel",
        trigger_config: { kind: "manual" },
      },
      references: { stages: { [ETAPA_AQUI]: "Proposta · Vendas" } },
    });
  });

  it("fluxo de OUTRA organização → 404", async () => {
    const id = randomUUID();
    const db = makeDb({
      followup_flow_pointers: [
        {
          id,
          organization_id: OUTRA_ORG,
          name: "Alheio",
          draft_graph: grafoQueMove(ETAPA_OUTRA),
          active_version_id: null,
        },
      ],
    });
    session("admin", db);
    const { GET } = await import("@/app/api/v1/ai/followup-flows/[id]/export/route");
    expect((await GET(getReq(), ctx(id))).status).toBe(404);
  });

  it("fluxo sem grafo → 422 flow_empty", async () => {
    const id = randomUUID();
    const db = makeDb({
      followup_flow_pointers: [
        { id, organization_id: ORG_ID, name: "Vazio", draft_graph: null, active_version_id: null },
      ],
    });
    session("viewer", db);
    const { GET } = await import("@/app/api/v1/ai/followup-flows/[id]/export/route");
    const res = await GET(getReq(), ctx(id));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("flow_empty");
  });
});

function arquivo(stageId: string, nomeDaEtapa = "Proposta · Vendas", nome = "Mover para proposta") {
  return {
    format: "followup_flow",
    version: 1,
    flow: {
      name: nome,
      handoff_policy: "pause",
      trigger_config: { kind: "manual" },
      graph: grafoQueMove(stageId),
    },
    references: { stages: { [stageId]: nomeDaEtapa } },
  };
}

describe("POST /api/v1/ai/followup-flows/import", () => {
  it("agent (< manager) → 403, nada gravado", async () => {
    const db = makeDb({});
    session("agent", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/import/route");
    expect((await POST(postReq({ file: arquivo(ETAPA_OUTRA) }))).status).toBe(403);
    expect(db.tables.followup_flow_pointers!).toHaveLength(0);
  });

  it("cria RASCUNHO sem versão, remapeia a etapa pelo nome e audita", async () => {
    const db = makeDb({
      crm_stages: [
        {
          id: ETAPA_AQUI,
          organization_id: ORG_ID,
          name: "Proposta",
          pipeline_id: PIPE,
          is_archived: false,
        },
        // A etapa de mesmo nome em OUTRA organização nunca pode ser a escolhida.
        {
          id: ETAPA_OUTRA,
          organization_id: OUTRA_ORG,
          name: "Proposta",
          pipeline_id: PIPE_OUTRA,
          is_archived: false,
        },
      ],
      crm_pipelines: [
        { id: PIPE, organization_id: ORG_ID, name: "Vendas" },
        { id: PIPE_OUTRA, organization_id: OUTRA_ORG, name: "Vendas" },
      ],
    });
    session("manager", db);
    const deFora = randomUUID();
    const { POST } = await import("@/app/api/v1/ai/followup-flows/import/route");
    const res = await POST(postReq({ file: arquivo(deFora) }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { flow: Row; pendencias: Row[] } };

    const gravado = db.tables.followup_flow_pointers![0]!;
    expect(gravado).toMatchObject({
      organization_id: ORG_ID,
      status: "draft",
      active_version_id: null,
      surface: "followup",
    });
    const mover = (gravado.draft_graph as FlowGraph).nodes.find((n) => n.id === "m1");
    expect(mover?.type === "move_lead" && mover.config.stage_id).toBe(ETAPA_AQUI);
    expect(body.data.pendencias).toEqual([
      expect.objectContaining({ codigo: "etapa_remapeada", bloqueia: false }),
    ]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "followup_flow.imported",
        organizationId: ORG_ID,
        metadata: expect.objectContaining({ pendencias: ["etapa_remapeada"], nodes: 3 }),
      }),
    );
  });

  it("nome ocupado ganha « (importado)»; `name` no corpo vence o do arquivo", async () => {
    const db = makeDb({
      followup_flow_pointers: [
        { id: randomUUID(), organization_id: ORG_ID, name: "Mover para proposta" },
      ],
    });
    session("manager", db);
    const { POST } = await import("@/app/api/v1/ai/followup-flows/import/route");
    const r1 = await POST(postReq({ file: arquivo(randomUUID()) }));
    expect(((await r1.json()) as { data: { flow: Row } }).data.flow.name).toBe(
      "Mover para proposta (importado)",
    );
    const r2 = await POST(postReq({ file: arquivo(randomUUID()), name: "Clínica B" }));
    expect(((await r2.json()) as { data: { flow: Row } }).data.flow.name).toBe("Clínica B");
  });

  it("arquivo inválido → 422 com a lista de problemas, nada gravado", async () => {
    const db = makeDb({});
    session("manager", db);
    const ruim = arquivo(randomUUID());
    (ruim.flow.graph.edges as Row[]).push({
      id: "solta",
      source: "t1",
      target: "fantasma",
      priority: 0,
      condition: { type: "always" },
    });
    const { POST } = await import("@/app/api/v1/ai/followup-flows/import/route");
    const res = await POST(postReq({ file: ruim }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { problemas: string[] } };
    };
    expect(body.error.code).toBe("invalid_flow_file");
    expect(body.error.details.problemas.join("\n")).toContain("fantasma");
    expect(db.tables.followup_flow_pointers!).toHaveLength(0);
  });

  it("JSON quebrado → 400", async () => {
    session("manager", makeDb({}));
    const { POST } = await import("@/app/api/v1/ai/followup-flows/import/route");
    expect((await POST(postReq("{ não é json"))).status).toBe(400);
  });

  it("roteiro de atendimento com o módulo desligado → 422 module_disabled", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    const db = makeDb({});
    session("manager", db);
    const roteiro = arquivo(randomUUID());
    (roteiro.flow as Row).surface = "atendimento";
    const { POST } = await import("@/app/api/v1/ai/followup-flows/import/route");
    const res = await POST(postReq({ file: roteiro }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("module_disabled");
    expect(db.tables.followup_flow_pointers!).toHaveLength(0);
  });

  it("tarefa de um COLEGA fica com ele: membros são lidos fora da RLS do gerente", async () => {
    const COLEGA = "55555555-5555-4555-8555-555555555555";
    // Pela sessão de um gerente, a RLS de `user_organizations` só devolve a
    // própria linha — o colega não aparece. O client admin (filtrado pela org)
    // aparece. Se a rota lesse pela sessão, a tarefa viraria «dono do lead».
    const sessao = makeDb({});
    const admin = makeDb({
      user_organizations: [
        { user_id: COLEGA, organization_id: ORG_ID, accepted_at: "2026-01-01", revoked_at: null },
        {
          user_id: USER_ID,
          organization_id: OUTRA_ORG,
          accepted_at: "2026-01-01",
          revoked_at: null,
        },
      ],
    });
    session("manager", sessao);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(createAdminClient).mockReturnValue(admin as any);
    const comTarefa = arquivo(randomUUID());
    (comTarefa.flow.graph.nodes as Row[]).splice(1, 0, {
      id: "it",
      type: "internal_task",
      label: "Ligar",
      position: pos,
      config: {
        titulo: "Ligar",
        vence_em_dias: 1,
        atribuir_a: { usuario_id: COLEGA },
        prioridade: "high",
      },
    });
    (comTarefa.flow.graph.edges as Row[]).push({
      id: "x3",
      source: "it",
      target: "e1",
      priority: 0,
      condition: { type: "always" },
    });
    const { POST } = await import("@/app/api/v1/ai/followup-flows/import/route");
    const res = await POST(postReq({ file: comTarefa }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { pendencias: Row[] } };
    expect(body.data.pendencias.map((p) => p.codigo)).not.toContain("responsavel_trocado");
    const tarefa = (sessao.tables.followup_flow_pointers![0]!.draft_graph as FlowGraph).nodes.find(
      (n) => n.id === "it",
    );
    expect(tarefa?.type === "internal_task" && tarefa.config.atribuir_a).toEqual({
      usuario_id: COLEGA,
    });
  });

  it("exportar e importar na MESMA conta mantém tudo, sem pendência", async () => {
    const id = randomUUID();
    const db = makeDb({
      followup_flow_pointers: [
        {
          id,
          organization_id: ORG_ID,
          name: "Original",
          draft_graph: grafoQueMove(ETAPA_AQUI),
          trigger_config: { kind: "lead_created" },
          handoff_policy: "allow",
          surface: "followup",
          active_version_id: null,
        },
      ],
      crm_stages: [
        {
          id: ETAPA_AQUI,
          organization_id: ORG_ID,
          name: "Proposta",
          pipeline_id: PIPE,
          is_archived: false,
        },
      ],
      crm_pipelines: [{ id: PIPE, organization_id: ORG_ID, name: "Vendas" }],
    });
    session("manager", db);
    const { GET } = await import("@/app/api/v1/ai/followup-flows/[id]/export/route");
    const exportado = ((await (await GET(getReq(), ctx(id))).json()) as { data: { file: unknown } })
      .data.file;
    const { POST } = await import("@/app/api/v1/ai/followup-flows/import/route");
    const res = await POST(postReq({ file: JSON.parse(JSON.stringify(exportado)) }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { flow: Row; pendencias: Row[] } };
    expect(body.data.pendencias).toEqual([]);
    expect(body.data.flow).toMatchObject({
      name: "Original (importado)",
      status: "draft",
      handoff_policy: "allow",
      trigger_config: { kind: "lead_created" },
      draft_graph: grafoQueMove(ETAPA_AQUI),
    });
  });
});
