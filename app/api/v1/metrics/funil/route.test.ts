/**
 * GET /api/v1/metrics/funil — a rota da análise do funil (issue #1750).
 *
 * Dados fixados, sem banco: a rota devolve conversão com amostra, mediana de
 * dias que declara ser mediana, ganho × perda por origem com valor por moeda e
 * a contra-métrica no MESMO corpo. Caso sem dado responde vazio explicando —
 * nunca NaN, nunca 0 fingindo medição.
 *
 * O falso NÃO é ingênuo (issue #2548): ele impõe o `max_rows = 1000` do
 * PostgREST — um `.limit(5000)` devolveria 1000 linhas caladas e o `truncado`
 * nunca ligaria — aplica os filtros no dataset de cada tabela (é assim que as
 * duas leituras de `crm_leads`, criados e encerrados, se separam) e só devolve
 * `count` quando a rota pede `exact`. Sem este teto o corte não aparece no
 * teste nenhum.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { temNaN } from "@/lib/metrics/funil";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const JANELA = "?from=2026-09-01T00:00:00.000Z&to=2026-10-01T00:00:00.000Z";
const URL = `http://localhost/api/v1/metrics/funil${JANELA}`;

/**
 * `supabase/config.toml` → `max_rows = 1000` (e é o padrão do Supabase
 * Cloud): o PostgREST corta a RESPOSTA nesse tanto, sem erro, mesmo com
 * `.limit()` maior. É este número que o falso aplica em TODA leitura.
 */
const MAX_ROWS = 1000;
/** O teto declarado na rota: 5 páginas de 1000 = 5000. */
const PAGINAS_MAXIMAS = 5;

function usuario(): AuthUser {
  return {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" }],
  } as AuthUser;
}

type Linha = Record<string, unknown>;
type Resposta = { data: unknown; error: { message: string } | null };

/**
 * Query builder mínimo com a régua do SERVIDOR.
 *
 * Cada tabela tem um dataset de linhas; os filtros são aplicados nele (é
 * assim que a leitura de `created_at` e a de `closed_at` se separam sem
 * `.or()`), `range` fatia o dataset e TODA resposta é cortada em `MAX_ROWS`.
 * `count` só vem quando a rota pede `exact` na primeira página.
 */
function fakeSupabase(dados: Record<string, Linha[]>, rpc: Resposta, erroEm?: string) {
  const consultas: Array<{
    tabela: string;
    filtros: Array<[string, unknown]>;
    ordens: string[];
    faixas: Array<[number, number]>;
    contou: boolean;
  }> = [];

  const client = {
    from(tabela: string) {
      const registro = {
        tabela,
        filtros: [] as Array<[string, unknown]>,
        ordens: [] as string[],
        faixas: [] as Array<[number, number]>,
        contou: false,
      };
      consultas.push(registro);

      const filtros: Array<(linha: Linha) => boolean> = [];
      let pediuCount = false;

      const executar = (faixa: [number, number] | null): Resposta & { count: number | null } => {
        if (erroEm === tabela) return { data: null, count: null, error: { message: "falhou" } };
        const base = (dados[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        const fatia = faixa ? base.slice(faixa[0], faixa[1] + 1) : base;
        return {
          data: fatia.slice(0, MAX_ROWS),
          count: pediuCount ? base.length : null,
          error: null,
        };
      };

      const builder: Record<string, unknown> = {};
      builder.select = (_colunas: string, opcoes?: { count?: string }) => {
        pediuCount = opcoes?.count === "exact";
        registro.contou = pediuCount;
        return builder;
      };
      builder.eq = (coluna: string, valor: unknown) => {
        registro.filtros.push([coluna, valor]);
        // Coluna ausente no dataset (ex.: `organization_id` de teste) não filtra.
        filtros.push((l) => !(coluna in l) || l[coluna] === valor);
        return builder;
      };
      builder.gte = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} >=`, valor]);
        filtros.push(
          (l) =>
            l[coluna] !== null && l[coluna] !== undefined && String(l[coluna]) >= String(valor),
        );
        return builder;
      };
      builder.lt = (coluna: string, valor: unknown) => {
        registro.filtros.push([`${coluna} <`, valor]);
        filtros.push(
          (l) => l[coluna] !== null && l[coluna] !== undefined && String(l[coluna]) < String(valor),
        );
        return builder;
      };
      builder.order = (coluna: string) => {
        registro.ordens.push(coluna);
        return builder;
      };
      builder.range = (inicio: number, fim: number) => {
        registro.faixas.push([inicio, fim]);
        return Promise.resolve(executar([inicio, fim]));
      };
      // O caminho de quem NÃO paginou (e o da sabotagem): também cortado em 1000.
      builder.limit = (n: number) => {
        const resposta = executar(null);
        return Promise.resolve({
          ...resposta,
          data: ((resposta.data as Linha[] | null) ?? []).slice(0, Math.min(n, MAX_ROWS)),
        });
      };
      builder.then = (
        ok?: (v: Resposta & { count: number | null }) => unknown,
        erro?: (e: unknown) => unknown,
      ): Promise<unknown> => Promise.resolve(executar(null)).then(ok, erro);
      return builder;
    },
    rpc: () => Promise.resolve(rpc),
  };
  return { consultas, client };
}

const ETAPAS: Linha[] = [
  { id: "A", name: "Contato", pipeline_id: "f1", position: 1 },
  { id: "B", name: "Proposta", pipeline_id: "f1", position: 2 },
];
const FUNIS: Linha[] = [{ id: "f1", name: "Vendas", position: 1 }];
const RPC_OK: Resposta = {
  data: { cliente: { turnos_p50: 6, turnos_p90: 12, descadastros: 2 } },
  error: null,
};

function lead(id: string, parcial: Record<string, unknown>): Linha {
  return {
    id,
    pipeline_id: "f1",
    stage_id: "A",
    status: "open",
    source: "instagram",
    value_cents: null,
    currency: null,
    created_at: "2026-09-10T12:00:00.000Z",
    closed_at: null,
    ...parcial,
  };
}

function atividade(leadId: string, quando: string): Linha {
  return {
    lead_id: leadId,
    payload: { from_stage_id: "A", to_stage_id: "B" },
    performed_at: quando,
  };
}

/** Fixture feliz: 4 nasceram em A, 3 passaram para B; 2 ganhos fecharam. */
function alegria(): Record<string, Linha[]> {
  return {
    crm_lead_activities: [
      atividade("l1", "2026-09-12T10:00:00.000Z"),
      atividade("l2", "2026-09-13T10:00:00.000Z"),
      atividade("l3", "2026-09-14T10:00:00.000Z"),
    ],
    crm_leads: [
      lead("l1", { stage_id: "B" }),
      lead("l2", { stage_id: "B" }),
      lead("l3", { stage_id: "B" }),
      lead("l4", { stage_id: "A" }),
      lead("g1", {
        status: "won",
        stage_id: "W",
        source: "site",
        value_cents: 120_00,
        currency: "BRL",
        created_at: "2026-09-01T00:00:00.000Z",
        closed_at: "2026-09-03T00:00:00.000Z",
      }),
      // g1 e g2 aparecem NAS DUAS leituras (criado e encerrado na janela): o
      // resultado é unido por id, então a origem não pode contá-los duas vezes.
      lead("g2", {
        status: "won",
        stage_id: "W",
        source: "site",
        value_cents: 90_00,
        currency: "BRL",
        created_at: "2026-09-01T00:00:00.000Z",
        closed_at: "2026-09-05T00:00:00.000Z",
      }),
    ],
    crm_stages: ETAPAS,
    crm_pipelines: FUNIS,
  };
}

async function chamar(): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new NextRequest(URL));
}

function permitido(): void {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: usuario(),
    org: { orgId: ORG_ID, name: "Org", role: "manager" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/metrics/funil", () => {
  it("devolve conversão com amostra, mediana de dias e ganho × perda por origem", async () => {
    permitido();
    const { consultas, client } = fakeSupabase(alegria(), RPC_OK);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;

    const conversao = corpo.conversao as {
      etapas: Array<{
        etapa: { id: string };
        entraram: number;
        passaram: number;
        taxa: number | null;
        amostra: number;
      }>;
    };
    const a = conversao.etapas.find((l) => l.etapa.id === "A");
    expect(a?.entraram).toBe(4);
    expect(a?.passaram).toBe(3);
    expect(a?.taxa).toBe(0.75);
    expect(a?.amostra).toBe(4);

    const dias = corpo.dias_ate_fechar as {
      medida: string;
      mediana: number | null;
      amostra: number;
    };
    expect(dias.medida).toBe("mediana");
    expect(dias.mediana).toBe(3);
    expect(dias.amostra).toBe(2);

    const origem = corpo.origem as {
      linhas: Array<{ origem: string; status: string; quantidade: number; por_moeda: unknown[] }>;
      valor_por_moeda: boolean;
    };
    expect(origem.valor_por_moeda).toBe(true);
    expect(origem.linhas.map((l) => `${l.origem}:${l.status}`)).toEqual([
      "instagram:open",
      "site:won",
    ]);
    // Dedup: g1 veio das DUAS leituras e conta uma vez só.
    expect(origem.linhas.find((l) => l.status === "won")?.quantidade).toBe(2);
    expect(origem.linhas.find((l) => l.status === "won")?.por_moeda).toEqual([
      { moeda: "BRL", quantidade: 2, valor_cents: 210_00 },
    ]);

    const contra = corpo.contra_metrica as {
      turnos: { p50: number | null } | null;
      opt_outs: { quantidade: number | null } | null;
      nota: string;
    };
    expect(contra.turnos?.p50).toBe(6);
    expect(contra.opt_outs?.quantidade).toBe(2);
    expect(contra.nota).toContain("turnos até o desfecho");

    expect(corpo.truncado).toBe(false);
    expect(corpo.vazio).toBeNull();
    expect(temNaN(corpo)).toBe(false);

    // Janela aplicada em TODAS as leituras, com a coluna certa em cada uma.
    const atividades = consultas.find((c) => c.tabela === "crm_lead_activities");
    expect(atividades?.filtros).toEqual([
      ["organization_id", ORG_ID],
      ["type", "stage_changed"],
      ["performed_at >=", "2026-09-01T00:00:00.000Z"],
      ["performed_at <", "2026-10-01T00:00:00.000Z"],
    ]);
    const leads = consultas.filter((c) => c.tabela === "crm_leads");
    expect(leads).toHaveLength(2);
    expect(leads[0]?.filtros.map((f) => f[0])).toEqual([
      "organization_id",
      "created_at >=",
      "created_at <",
    ]);
    expect(leads[1]?.filtros.map((f) => f[0])).toEqual([
      "organization_id",
      "closed_at >=",
      "closed_at <",
    ]);
    expect(consultas).toHaveLength(5);
  });

  it("lê 1.200 linhas inteiras apesar do teto de 1.000 do PostgREST (issue #2548)", async () => {
    permitido();
    const N = 1200;
    const { consultas, client } = fakeSupabase(
      {
        crm_lead_activities: Array.from({ length: N }, (_, i) =>
          atividade(`x${i}`, "2026-09-12T10:00:00.000Z"),
        ),
        crm_leads: Array.from({ length: N }, (_, i) => lead(`x${i}`, { stage_id: "B" })),
        crm_stages: ETAPAS,
        crm_pipelines: FUNIS,
      },
      RPC_OK,
    );
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;

    // Com `.limit(LIMITE)` isto seria 1000 (o servidor corta em max_rows).
    const conversao = corpo.conversao as {
      etapas: Array<{ etapa: { id: string }; entraram: number; passaram: number }>;
    };
    const a = conversao.etapas.find((l) => l.etapa.id === "A");
    expect(a?.entraram).toBe(N);
    expect(a?.passaram).toBe(N);
    // Página 2 veio CURTA (200 linhas) e ainda assim não é fim: o fim veio do count.
    expect(corpo.truncado).toBe(false);
    expect(temNaN(corpo)).toBe(false);

    const paginas = consultas
      .filter((c) => c.tabela === "crm_lead_activities")
      .map((c) => c.faixas[0]);
    expect(paginas).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    const ordens = consultas.filter((c) => c.tabela === "crm_lead_activities").map((c) => c.ordens);
    expect(ordens).toEqual([
      ["performed_at", "id"],
      ["performed_at", "id"],
    ]);
    // `count` exato SÓ na primeira página — é ele que prova o fim.
    expect(
      consultas.filter((c) => c.tabela === "crm_lead_activities").map((c) => c.contou),
    ).toEqual([true, false]);

    const criados = consultas.filter(
      (c) => c.tabela === "crm_leads" && c.filtros.some((f) => f[0] === "created_at >="),
    );
    expect(criados.map((c) => c.faixas[0])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(criados.map((c) => c.ordens[0])).toEqual(["created_at", "created_at"]);
    const encerrados = consultas.filter(
      (c) => c.tabela === "crm_leads" && c.filtros.some((f) => f[0] === "closed_at >="),
    );
    expect(encerrados).toHaveLength(1);
    expect(encerrados[0]?.ordens).toEqual(["closed_at", "id"]);
  });

  it("acima do teto de 5.000 linhas responde truncado: true", async () => {
    permitido();
    const N = PAGINAS_MAXIMAS * 1000 + 1;
    const { consultas, client } = fakeSupabase(
      {
        crm_lead_activities: Array.from({ length: N }, (_, i) =>
          atividade(`x${i}`, "2026-09-12T10:00:00.000Z"),
        ),
        crm_leads: [lead("x0", { stage_id: "B" })],
        crm_stages: ETAPAS,
        crm_pipelines: FUNIS,
      },
      RPC_OK,
    );
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;

    expect(corpo.truncado).toBe(true);
    const paginas = consultas
      .filter((c) => c.tabela === "crm_lead_activities")
      .map((c) => c.faixas[0]);
    expect(paginas).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [3000, 3999],
      [4000, 4999],
    ]);
  });

  it("erro numa das leituras paginadas vira 500 apontando a tabela", async () => {
    permitido();
    const { client } = fakeSupabase({ crm_lead_activities: [] }, RPC_OK, "crm_leads");
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(500);
    const erro = (await res.json()) as { error: { code?: string; message: string } };
    expect(erro.error.message).toContain("crm_leads");
  });

  it("conta a passagem gravada como { de, para } (agente, handoff, agenda)", async () => {
    permitido();
    const fila = alegria();
    // l3 movido pela IA: lib/leads/agent-stage-sync.ts grava `{ de, para }`.
    fila.crm_lead_activities = [
      atividade("l1", "2026-09-12T10:00:00.000Z"),
      atividade("l2", "2026-09-13T10:00:00.000Z"),
      {
        lead_id: "l3",
        payload: { passo_do_agente: "qualificou", de: "A", para: "B" },
        performed_at: "2026-09-14T10:00:00.000Z",
      },
    ];
    const { client } = fakeSupabase(fila, RPC_OK);
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;
    const conversao = corpo.conversao as {
      etapas: Array<{
        etapa: { id: string };
        entraram: number;
        passaram: number;
        taxa: number | null;
      }>;
    };
    const a = conversao.etapas.find((l) => l.etapa.id === "A");
    expect(a?.passaram).toBe(3);
    expect(a?.taxa).toBe(0.75);
  });

  it("sem dado nenhum: devolve vazio explicando, com números nulos e sem NaN", async () => {
    permitido();
    const { client } = fakeSupabase(
      {
        crm_lead_activities: [],
        crm_leads: [],
        crm_stages: ETAPAS,
        crm_pipelines: FUNIS,
      },
      { data: { cliente: { turnos_p50: null, turnos_p90: null, descadastros: 0 } }, error: null },
    );
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;

    const vazio = corpo.vazio as { motivo: string } | null;
    expect(vazio?.motivo).toContain("sem dado");
    expect((corpo.conversao as { etapas: unknown[] }).etapas).toEqual([]);
    expect((corpo.dias_ate_fechar as { mediana: number | null }).mediana).toBeNull();
    expect((corpo.origem as { linhas: unknown[] }).linhas).toEqual([]);
    expect(temNaN(corpo)).toBe(false);
  });

  it("falha na RPC de contra-métrica não derruba a rota: vem null com a razão", async () => {
    permitido();
    const { client } = fakeSupabase(
      {
        crm_lead_activities: [],
        crm_leads: [],
        crm_stages: ETAPAS,
        crm_pipelines: FUNIS,
      },
      { data: null, error: { message: "RPC indisponível" } },
    );
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar();
    expect(res.status).toBe(200);
    const corpo = ((await res.json()) as { data: Record<string, unknown> }).data;
    const contra = corpo.contra_metrica as { turnos: unknown; nota: string };
    expect(contra.turnos).toBeNull();
    expect(contra.nota).toContain("não medida");
    expect(temNaN(corpo)).toBe(false);
  });

  it("leitura recusada para quem não é agent", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Papel insuficiente.", 403, {}),
    } as never);

    const { GET } = await import("./route");
    const res = await GET(new NextRequest(URL));
    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });
});
