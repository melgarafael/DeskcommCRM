import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser } from "@/lib/auth/types";

/**
 * Task 2 — GET/PUT /api/v1/pipelines/[id]/agent-mapping.
 *
 * O banco aqui é um dublê que APLICA os filtros `eq`, a lista de colunas do
 * `select()` e o `order()` de verdade. Um stub que devolve linha fixa faria o
 * teste de outra organização passar mesmo com o `eq("organization_id", …)`
 * apagado da rota — mediria o dublê, não o handler; e um `order()` no-op deixaria
 * "apagar o `.order` da rota" verde enquanto o funil aparece embaralhado na tela.
 * Ele também registra CADA update com seus filtros e com marcas de início/fim,
 * porque duas garantias desta task são sobre a emissão em si: "nenhum UPDATE
 * quando é 404" e "um de cada vez, em sequência".
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PIPE = "44444444-4444-4444-8444-444444444444";

interface StageRow {
  id: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  agent_stage_hint: string | null;
  pipeline_id: string;
  organization_id: string;
}

function etapa(over: Partial<StageRow> & { id: string; name: string }): StageRow {
  return {
    position: 1,
    is_won: false,
    is_lost: false,
    is_archived: false,
    agent_stage_hint: null,
    pipeline_id: PIPE,
    organization_id: ORG_ID,
    ...over,
  };
}

interface DbOpts {
  pipelineOrg?: string;
  stages?: StageRow[];
  updateError?: (n: number) => { code: string; message: string } | null;
}

function makeDb(opts: DbOpts = {}) {
  const registro = {
    updates: [] as Array<{ hint: unknown; filtros: Array<[string, unknown]> }>,
    eventos: [] as string[],
  };
  let nUpdate = 0;

  const tables: Record<string, Array<Record<string, unknown>>> = {
    crm_pipelines: [
      { id: PIPE, name: "Pedidos", organization_id: opts.pipelineOrg ?? ORG_ID },
    ],
    crm_stages: (opts.stages ?? []) as unknown as Array<Record<string, unknown>>,
  };

  function builder(table: string) {
    const filtros: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    let colunas: string[] | null = null;
    let ordem: string | null = null;

    const casam = () =>
      (tables[table] ?? []).filter((r) => filtros.every(([c, v]) => r[c] === v));

    /** Ordena e projeta como o PostgREST faria: `order()` e a lista do `select()`. */
    const lidos = () => {
      const rows = [...casam()];
      if (ordem) rows.sort((a, b) => Number(a[ordem!]) - Number(b[ordem!]));
      if (!colunas) return rows;
      return rows.map((r) => Object.fromEntries(colunas!.map((c) => [c, r[c]])));
    };

    async function run(): Promise<{ data: unknown; error: unknown }> {
      if (patch) {
        const i = nUpdate++;
        registro.updates.push({ hint: patch.agent_stage_hint, filtros: [...filtros] });
        registro.eventos.push(`start:${i}`);
        // Folga real: sem ela, updates disparados em paralelo teriam o mesmo
        // intercalamento de um laço sequencial e o teste de sequência não mediria nada.
        await new Promise((r) => setTimeout(r, 0));
        registro.eventos.push(`end:${i}`);
        const err = opts.updateError?.(i + 1) ?? null;
        if (err) return { data: null, error: err };
        for (const r of casam()) Object.assign(r, patch);
        return { data: null, error: null };
      }
      return { data: lidos(), error: null };
    }

    const b = {
      select: (cols?: string) => {
        colunas = cols ? cols.split(",").map((c) => c.trim()) : null;
        return b;
      },
      update: (p: Record<string, unknown>) => {
        patch = p;
        return b;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return b;
      },
      order: (col: string) => {
        ordem = col;
        return b;
      },
      maybeSingle: async () => {
        const r = await run();
        return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error };
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej),
    };
    return b;
  }

  vi.mocked(createClient).mockResolvedValue({ from: builder } as never);
  return registro;
}

function authOk(role: "manager" | "admin" = "manager") {
  const user: AuthUser = {
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role },
  });
}

const ctx = { params: Promise.resolve({ id: PIPE }) };

function reqGet() {
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/agent-mapping`);
}
function reqPut(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/agent-mapping`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** O mapa completo dos sete passos — o corpo do PUT é total, nunca um delta. */
function mapa(over: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    new: null,
    contacted: null,
    qualifying: null,
    qualified: null,
    negotiating: null,
    won: null,
    lost: null,
    ...over,
  };
}

/**
 * Funil de trabalho: uma etapa livre, uma ocupada, ganho e perda já mapeados.
 *
 * DE PROPÓSITO fora da ordem de `position` — se a tabela já viesse ordenada, o
 * `.order("position")` da rota poderia sumir com a suíte verde e a tela mostraria
 * as etapas embaralhadas.
 */
function funil(): StageRow[] {
  return [
    etapa({ id: "e3", name: "Fechado", position: 3, is_won: true, agent_stage_hint: "won" }),
    etapa({ id: "e1", name: "Novo", position: 1 }),
    etapa({ id: "e4", name: "Perdido", position: 4, is_lost: true, agent_stage_hint: "lost" }),
    etapa({ id: "e2", name: "Proposta", position: 2, agent_stage_hint: "negotiating" }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/pipelines/[id]/agent-mapping", () => {
  it("sem auth → repassa a resposta do requireRole", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const { GET } = await import("./route");
    expect((await GET(reqGet(), ctx)).status).toBe(401);
  });

  it("exige manager", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { GET } = await import("./route");
    await GET(reqGet(), ctx);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("pipeline de outra organização → 404", async () => {
    authOk();
    makeDb({ pipelineOrg: OUTRA_ORG, stages: funil() });
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(404);
  });

  it("devolve as etapas ativas e o mapa dos sete passos", async () => {
    authOk();
    makeDb({
      stages: [
        ...funil(),
        etapa({ id: "e9", name: "Arquivada", position: 9, is_archived: true, agent_stage_hint: "qualifying" }),
      ],
    });
    const { GET } = await import("./route");
    const res = await GET(reqGet(), ctx);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        etapas: Array<{ id: string; name: string; is_won: boolean; is_lost: boolean }>;
        mapeamento: Record<string, string | null>;
      };
    };

    // Duas coisas de uma vez, e as duas são contrato de tela: a ORDEM é a do
    // funil (a fixture chega embaralhada), e a etapa arquivada não pode ser
    // oferecida — o board não a mostra e o índice único do banco a ignora, então
    // escolhê-la seria um mapeamento invisível.
    expect(body.data.etapas.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
    // A autoria viaja junto (migration 0101) e é `null` na fixture, que é o
    // estado honesto de uma etapa anterior à coluna. Fica no `toEqual` exato de
    // propósito: é o que impede a projeção de crescer sem ninguém decidir.
    expect(body.data.etapas[0]).toEqual({
      id: "e1",
      name: "Novo",
      is_won: false,
      is_lost: false,
      last_change_actor_kind: null,
      last_change_at: null,
    });

    expect(body.data.mapeamento).toEqual(
      mapa({ negotiating: "e2", won: "e3", lost: "e4" }),
    );
    // O hint da arquivada não vaza para o mapa.
    expect(body.data.mapeamento.qualifying).toBeNull();
  });
});

describe("PUT /api/v1/pipelines/[id]/agent-mapping", () => {
  it("papel abaixo de manager → 403 e nenhum UPDATE", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Permissão insuficiente. Requer role >= manager.", 403, {}),
    });
    const db = makeDb({ stages: funil() });
    const { PUT } = await import("./route");
    const res = await PUT(reqPut({ mapeamento: mapa({ new: "e1" }) }), ctx);
    expect(res.status).toBe(403);
    expect(db.updates).toEqual([]);
  });

  /**
   * O 403 acima mocka o `requireRole` para falhar SEMPRE — passaria igual se a
   * escrita pedisse `agent`. Quem prova o papel da escrita é este.
   */
  it("exige manager para escrever", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { PUT } = await import("./route");
    await PUT(reqPut({ mapeamento: mapa({ new: "e1", won: "e3", lost: "e4" }) }), ctx);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  /**
   * ⭐ O teste que mais importa. O pipeline EXISTE — só que noutra organização.
   * Um handler que responde 404 depois de gravar é pior que um que responde 200,
   * então o veredito não é o status: é a lista de updates emitidos.
   */
  it("pipeline de outra organização → 404 e NENHUM UPDATE emitido", async () => {
    authOk();
    const db = makeDb({
      pipelineOrg: OUTRA_ORG,
      stages: funil().map((e) => ({ ...e, organization_id: OUTRA_ORG })),
    });
    const { PUT } = await import("./route");
    const res = await PUT(reqPut({ mapeamento: mapa({ new: "e1", negotiating: null }) }), ctx);

    expect(res.status).toBe(404);
    expect(db.updates).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("mapeamento incoerente → 422 com a mensagem da regra, e nenhum UPDATE", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PUT } = await import("./route");
    // «Novo» não é a etapa de ganho — a regra pura recusa antes do banco.
    const res = await PUT(reqPut({ mapeamento: mapa({ won: "e1" }) }), ctx);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string; details: { erros: string[] } } };
    expect(body.error.code).toBe("unprocessable_entity");
    // A mensagem chega inteira, com o NOME da etapa e o rótulo em português.
    expect(body.error.details.erros).toEqual([
      'A etapa «Novo» não é a etapa de fechamento (ganho) deste funil, então não pode representar «Ganho».',
    ]);
    expect(body.error.message).toBe(body.error.details.erros[0]);
    expect(db.updates).toEqual([]);
  });

  it("corpo sem os sete passos → 422 de validação, e nenhum UPDATE", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PUT } = await import("./route");
    const res = await PUT(reqPut({ mapeamento: { new: "e1" } }), ctx);

    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(db.updates).toEqual([]);
  });

  it("caminho feliz → emite só os updates do diff, liberando antes de ocupar", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PUT } = await import("./route");
    // «Proposta» larga 'negotiating'; «Novo» passa a valer 'new'. Ganho e perda
    // seguem como estão — e não podem gerar update.
    const res = await PUT(
      reqPut({ mapeamento: mapa({ new: "e1", won: "e3", lost: "e4" }) }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(db.updates.map((u) => u.hint)).toEqual([null, "new"]);
    expect(db.updates[0]?.filtros).toContainEqual(["id", "e2"]);
    expect(db.updates[1]?.filtros).toContainEqual(["id", "e1"]);
    // Service role não é usado aqui, mas o filtro explícito de tenant é a
    // convenção do repo e a rede que sobra se a RLS mudar.
    for (const u of db.updates) {
      expect(u.filtros).toContainEqual(["organization_id", ORG_ID]);
      expect(u.filtros).toContainEqual(["pipeline_id", PIPE]);
    }

    const body = (await res.json()) as { data: { mapeamento: Record<string, string | null> } };
    expect(body.data.mapeamento).toEqual(mapa({ new: "e1", won: "e3", lost: "e4" }));
  });

  it("aplica os UPDATEs um de cada vez, em sequência", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PUT } = await import("./route");
    await PUT(reqPut({ mapeamento: mapa({ new: "e1", won: "e3", lost: "e4" }) }), ctx);

    // Em paralelo os dois `start` sairiam antes do primeiro `end`, e o índice
    // único recusaria a ocupação enquanto a outra etapa ainda declara o passo.
    expect(db.eventos).toEqual(["start:0", "end:0", "start:1", "end:1"]);
  });

  it("mapa idêntico ao atual → 200, nenhum UPDATE, nenhum audit", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { PUT } = await import("./route");
    const res = await PUT(
      reqPut({ mapeamento: mapa({ negotiating: "e2", won: "e3", lost: "e4" }) }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(db.updates).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("caminho feliz audita pipeline.agent_mapping_updated", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { PUT } = await import("./route");
    await PUT(reqPut({ mapeamento: mapa({ new: "e1", won: "e3", lost: "e4" }) }), ctx);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.agent_mapping_updated",
        organizationId: ORG_ID,
        resourceId: PIPE,
      }),
    );
  });

  it("23505 do índice único → 409 citando a etapa em conflito", async () => {
    authOk();
    makeDb({
      stages: funil(),
      updateError: (n) =>
        n === 2
          ? { code: "23505", message: 'duplicate key value violates unique constraint "uniq_crm_stages_pipeline_hint"' }
          : null,
    });
    const { PUT } = await import("./route");
    const res = await PUT(reqPut({ mapeamento: mapa({ new: "e1", won: "e3", lost: "e4" }) }), ctx);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("state_conflict");
    expect(body.error.message).toContain("Novo");
    expect(body.error.message).not.toContain("e1");
  });

  /**
   * Alcançável se `is_won`/`is_lost` mudarem entre a leitura e a gravação. Raro,
   * mas o texto do Postgres não pode ser o que o dono da clínica lê — é a mesma
   * mensagem que a camada pura existe para evitar.
   */
  it("23514 do CHECK → 409 em português, sem texto do Postgres", async () => {
    authOk();
    makeDb({
      stages: funil(),
      updateError: (n) =>
        n === 1
          ? {
              code: "23514",
              message:
                'new row for relation "crm_stages" violates check constraint "crm_stages_hint_coerente_com_won_lost"',
            }
          : null,
    });
    const { PUT } = await import("./route");
    const res = await PUT(reqPut({ mapeamento: mapa({ new: "e1", won: "e3", lost: "e4" }) }), ctx);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("state_conflict");
    expect(body.error.message).toContain("Proposta");
    expect(body.error.message).toContain("Recarregue a página");
    expect(body.error.message).not.toContain("check constraint");
  });

  it("erro inesperado do banco → 500, sem inventar sucesso", async () => {
    authOk();
    makeDb({
      stages: funil(),
      updateError: (n) => (n === 1 ? { code: "08006", message: "connection failure" } : null),
    });
    const { PUT } = await import("./route");
    const res = await PUT(reqPut({ mapeamento: mapa({ new: "e1", won: "e3", lost: "e4" }) }), ctx);
    expect(res.status).toBe(500);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
