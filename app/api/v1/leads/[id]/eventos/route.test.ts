/**
 * GET /api/v1/leads/[id]/eventos — a leitura do `event_log` que alimenta o
 * aviso dentro do app quando a SESSÃO nunca viu o negócio (issue #3224).
 *
 * O que se prova aqui: a rota lê os três tipos que viram aviso já filtrados
 * pela organização ATIVA em SQL (evento da outra org nunca sai daqui — a RLS
 * deixaria passar as duas), devolve a linha reduzida com o destinatário do
 * payload, e quem não enxerga o negócio toma 404 sem uma única leitura de
 * eventos. O casamento do evento com a transação do UPDATE é de
 * `hooks/notifications/aviso-de-negocio.ts` (`avisosDoBanco`), provado no
 * teste do hook.
 *
 * Roda com: npx vitest run "app/api/v1/leads/[id]/eventos/route.test.ts"
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  orgId: "22222222-2222-4222-8222-222222222222",
  leadId: "11111111-1111-4111-8111-111111111111",
  leadVisivel: true as boolean,
  eventos: [] as unknown[],
  erroEventos: null as { message: string } | null,
  eqsDoEvento: [] as Array<[string, unknown]>,
  filtrosIn: [] as Array<[string, unknown]>,
  tabelas: [] as string[],
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u-ana", idioma: "pt-BR" },
    org: { orgId: estado.orgId, name: "Org", role: "agent" },
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      estado.tabelas.push(tabela);
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          if (tabela === "event_log") estado.eqsDoEvento.push([coluna, valor]);
          return cadeia;
        },
        in: (coluna: string, valores: unknown) => {
          if (tabela === "event_log") estado.filtrosIn.push([coluna, valores]);
          return cadeia;
        },
        order: () => cadeia,
        limit: async () => ({ data: estado.eventos, error: estado.erroEventos }),
        maybeSingle: async () => ({
          data: estado.leadVisivel ? { id: estado.leadId } : null,
          error: null,
        }),
      };
      return cadeia;
    },
  }),
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { GET } from "./route";

async function pergunta(id = estado.leadId) {
  const res = await GET(new NextRequest(`http://localhost/api/v1/leads/${id}/eventos`), {
    params: Promise.resolve({ id }),
  });
  return {
    status: res.status,
    corpo: (await res.json()) as { data?: { eventos: unknown[] }; error?: { code: string } },
  };
}

function evento(organization_id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organization_id,
    event_type: "lead.assigned",
    entity_id: estado.leadId,
    created_at: "2026-10-25T12:00:00.000Z",
    payload: { lead_id: estado.leadId, to_user_id: "u-ana" },
    ...extra,
  };
}

beforeEach(() => {
  estado.leadVisivel = true;
  estado.eventos = [];
  estado.erroEventos = null;
  estado.eqsDoEvento = [];
  estado.filtrosIn = [];
  estado.tabelas = [];
});

describe("GET /api/v1/leads/[id]/eventos (#3224)", () => {
  it("devolve os eventos reduzidos, com o destinatário tirado do payload", async () => {
    estado.eventos = [
      evento(estado.orgId),
      evento(estado.orgId, {
        event_type: "lead.won",
        created_at: "2026-10-25T12:00:01.000Z",
        payload: { lead_id: estado.leadId, value_cents: 50_000 },
      }),
    ];
    const { status, corpo } = await pergunta();
    expect(status).toBe(200);
    expect(corpo.data?.eventos).toEqual([
      {
        organization_id: estado.orgId,
        event_type: "lead.assigned",
        entity_id: estado.leadId,
        created_at: "2026-10-25T12:00:00.000Z",
        to_user_id: "u-ana",
      },
      {
        organization_id: estado.orgId,
        event_type: "lead.won",
        entity_id: estado.leadId,
        created_at: "2026-10-25T12:00:01.000Z",
        to_user_id: null,
      },
    ]);
  });

  it("(D) a organização ATIVA vai para o SQL, e só os tipos de aviso são lidos", async () => {
    await pergunta();
    // `organization_id` em cláusula, não só na RLS: o membro de duas orgs
    // passaria pelas duas policies, e o evento da outra nunca vira aviso.
    expect(estado.eqsDoEvento).toEqual([
      ["organization_id", estado.orgId],
      ["entity_kind", "lead"],
      ["entity_id", estado.leadId],
    ]);
    expect(estado.filtrosIn).toEqual([
      ["event_type", ["lead.assigned", "lead.won", "lead.lost"]],
    ]);
  });

  it("(D) linha de outra organização que escorregue na resposta é cortada", async () => {
    estado.eventos = [evento(estado.orgId), evento("outra-organizacao")];
    const { status, corpo } = await pergunta();
    expect(status).toBe(200);
    expect(corpo.data?.eventos).toHaveLength(1);
    expect(corpo.data?.eventos[0]).toMatchObject({ organization_id: estado.orgId });
  });

  it("negócio que a sessão não enxerga → 404, sem ler event_log nenhum", async () => {
    estado.leadVisivel = false;
    const { status, corpo } = await pergunta();
    expect(status).toBe(404);
    expect(corpo.error?.code).toBe("not_found");
    expect(estado.tabelas).toEqual(["crm_leads"]);
    expect(estado.eqsDoEvento).toEqual([]);
  });

  it("id que não é uuid → 404, sem tocar em banco", async () => {
    expect((await pergunta("nao-e-uuid")).status).toBe(404);
    expect(estado.tabelas).toEqual([]);
  });

  it("falha de leitura → 500 (e o hook cai para o silêncio)", async () => {
    estado.erroEventos = { message: "boom" };
    expect((await pergunta()).status).toBe(500);
  });
});
