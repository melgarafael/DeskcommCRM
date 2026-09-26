/**
 * A previsão respeita a visibilidade por atendente (issue #1535, migration 0036).
 *
 * O critério de aceite é: um atendente com `visibility_mode = "own"` só vê a
 * previsão dos PRÓPRIOS negócios. Mecanismo: a rota usa o client de SESSÃO, e é
 * a RLS que filtra — um cliente admin/service-role furaria o `visibility_mode`
 * e devolveria a previsão da equipe inteira.
 *
 * Este teste pinça exatamente essa escolha: o client usado é o de sessão, o
 * admin não é nem chamado, e a resposta contém só o negócio do atendente.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const ORG = "22222222-2222-4222-8222-222222222222";
const PIPE = "44444444-4444-4444-8444-444444444444";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Linha = Record<string, unknown>;

/**
 * Um client falso que registra o que foi consultado e o que foi filtrado.
 *
 * `visibilityOwn` MODEL A RLS da migration 0036: com
 * `organizations.settings.visibility_mode = "own"`, a policy de `crm_leads`
 * devolve só `owner_user_id = auth.uid()` para o papel `agent`. É exatamente o
 * recorte que um client admin não aplicaria — por isso o dublê tem de saber
 * qual dos dois está sendo usado.
 */
function clienteFake(
  linhasPorTabela: Record<string, Linha[]>,
  opcoes: { visibilityOwn?: boolean } = {},
) {
  const tabelas: string[] = [];
  const filtros: Array<[string, unknown]> = [];

  const from = (tabela: string) => {
    tabelas.push(tabela);
    let linhas = [...(linhasPorTabela[tabela] ?? [])];
    if (tabela === "crm_leads" && opcoes.visibilityOwn) {
      linhas = linhas.filter((l) => l.owner_user_id === USER);
    }
    const q: {
      select: () => typeof q;
      order: () => typeof q;
      eq: (col: string, valor: unknown) => typeof q;
      maybeSingle: () => Promise<{ data: Linha | null; error: null }>;
      then: (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise<unknown>;
    } = {
      select: () => q,
      order: () => q,
      eq: (col, valor) => {
        filtros.push([col, valor]);
        linhas = linhas.filter((l) => l[col] === valor);
        return q;
      },
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (ok, erro) => Promise.resolve({ data: linhas, error: null }).then(ok, erro),
    };
    return q;
  };

  return { client: { from } as never, tabelas, filtros };
}

// As linhas trazem os mesmos filtros que a rota aplica (tenant + funil): o
// client falso aplica `.eq` de verdade, então dado sem o campo seria filtrado
// fora — e o teste mediria o próprio dublê, não a rota.
const PIPELINE_ROW = {
  id: PIPE,
  organization_id: ORG,
  settings: null as Record<string, unknown> | null,
};
const ETAPA_ROW = {
  id: "etapa-1",
  name: "Proposta",
  organization_id: ORG,
  pipeline_id: PIPE,
  is_won: false,
  is_lost: false,
  is_archived: false,
  win_probability: 50,
};

function authOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
    },
    org: { orgId: ORG, name: "Org", role: "agent" as const },
  } as never);
}

function reqGet() {
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/forecast`, {
    method: "GET",
  });
}

const ctx = { params: Promise.resolve({ id: PIPE }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines/[id]/forecast — visibilidade", () => {
  it("com visibility_mode own, o atendente vê SÓ os próprios negócios", async () => {
    authOk();

    // A RLS com visibility_mode="own" devolveria só os negócios do atendente.
    // É o client de SESSÃO que passa por ela — e é nele que este teste aponta.
    const sessao = clienteFake(
      {
        crm_pipelines: [PIPELINE_ROW],
        crm_stages: [ETAPA_ROW],
        crm_leads: [
          {
            id: "meu",
            organization_id: ORG,
            pipeline_id: PIPE,
            stage_id: "etapa-1",
            status: "open",
            value_cents: 100_000,
            currency: "BRL",
            expected_close_date: "2026-10-10",
            owner_user_id: USER,
          },
          {
            id: "do-outro",
            organization_id: ORG,
            pipeline_id: PIPE,
            stage_id: "etapa-1",
            status: "open",
            value_cents: 900_000,
            currency: "BRL",
            expected_close_date: "2026-10-10",
            owner_user_id: OUTRO,
          },
        ],
      },
      { visibilityOwn: true },
    );
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("@/app/api/v1/pipelines/[id]/forecast/route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        totais: Array<{ moeda: string; bruto_cents: number; ponderado_cents: number; n: number }>;
      };
    };

    // Só o negócio do atendente: R$ 1.000,00 a 50% → R$ 500,00.
    expect(body.data.totais).toEqual([
      { moeda: "BRL", bruto_cents: 100_000, ponderado_cents: 50_000, n: 1 },
    ]);

    // O client admin (service-role, bypassa RLS) nem é cogitado.
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("filtra por organization_id do JWT em toda leitura", async () => {
    authOk();

    const sessao = clienteFake({
      crm_pipelines: [PIPELINE_ROW],
      crm_stages: [ETAPA_ROW],
      crm_leads: [],
    });
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("@/app/api/v1/pipelines/[id]/forecast/route");
    await GET(reqGet(), ctx);

    const orgsConsultadas = sessao.filtros.filter(
      ([col, valor]) => col === "organization_id" && valor === ORG,
    );
    // funil + etapas + negócios: três leituras, três com o filtro de tenant.
    expect(orgsConsultadas).toHaveLength(3);
  });

  it("papel menor que agent → a resposta do requireRole, sem nem abrir client", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente.", 403, {}),
    });

    const { GET } = await import("@/app/api/v1/pipelines/[id]/forecast/route");
    const res = await GET(reqGet(), ctx);

    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("funil de outra organização → 404, sem vazar que ele existe", async () => {
    authOk();

    const sessao = clienteFake({
      crm_pipelines: [], // a RLS/filtro não devolve o funil
      crm_stages: [],
      crm_leads: [],
    });
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("@/app/api/v1/pipelines/[id]/forecast/route");
    const res = await GET(reqGet(), ctx);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Funil não encontrado");
  });

  it("fonte 'ia_quando_houver' lê a pontuação da IA junto", async () => {
    authOk();

    const sessao = clienteFake({
      crm_pipelines: [
        {
          id: PIPE,
          organization_id: ORG,
          settings: { previsao: { fonte: "ia_quando_houver" } },
        },
      ],
      crm_stages: [ETAPA_ROW],
      crm_leads: [
        {
          id: "meu",
          organization_id: ORG,
          pipeline_id: PIPE,
          stage_id: "etapa-1",
          status: "open",
          value_cents: 100_000,
          currency: "BRL",
          expected_close_date: "2026-10-10",
        },
      ],
      crm_lead_scores: [{ lead_id: "meu", organization_id: ORG, ai_probability: 80 }],
    });
    vi.mocked(createClient).mockResolvedValue(sessao.client);

    const { GET } = await import("@/app/api/v1/pipelines/[id]/forecast/route");
    const res = await GET(reqGet(), ctx);
    const body = (await res.json()) as {
      data: { fonte: string; totais: Array<{ ponderado_cents: number }> };
    };

    expect(body.data.fonte).toBe("ia_quando_houver");
    // 80% da IA, não os 50% da etapa.
    expect(body.data.totais[0]?.ponderado_cents).toBe(80_000);
    expect(sessao.tabelas).toContain("crm_lead_scores");
  });
});
