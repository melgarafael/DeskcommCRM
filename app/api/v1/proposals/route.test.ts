import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { sePropostasDesligadas } from "@/lib/propostas/porta";

vi.mock("@/lib/propostas/porta", () => ({ sePropostasDesligadas: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Isola o handler do gate de suporte (autoridade própria testada em
// lib/impersonate/support.test.ts) — nenhum teste aqui exercita acompanhamento.
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "44444444-4444-4444-8444-444444444444";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";
const PRODUCT_ID = "66666666-6666-4666-8666-666666666666";
const PRODUCT_DE_OUTRA_ORG = "77777777-7777-4777-8777-777777777777";
const RASCUNHO_EXISTENTE_ID = "88888888-8888-4888-8888-888888888888";

const ROLE_RANK: Record<string, number> = { viewer: 1, agent: 2, ai_operator: 3, manager: 4, admin: 5 };

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/proposals", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

interface MundoOpts {
  /** Simula um lead cujo organization_id é de OUTRA organização — a query
   * org-scoped não o encontra, exatamente como o Postgres real faria. */
  leadPertenceAOutraOrg?: boolean;
  papel?: keyof typeof ROLE_RANK;
  /** Preço que o mock de catalog_products devolve; null = produto não resolve
   * (outra org, apagado, inativo). Default: 3000. */
  precoDoCatalogo?: number | null;
  /** Moeda que o mock de catalog_products devolve (D11). Default: "BRL". */
  moedaDoCatalogo?: string;
  /** Quando true, a pré-checagem de rascunho encontra um rascunho aberto. */
  rascunhoJaExiste?: boolean;
  /** Sobrescreve organizations.settings.proposals.default_conditions. */
  condicoesPadrao?: string | null;
  /** Força o INSERT de crm_proposal_items a falhar (revisão C3, I2). */
  itensFalham?: boolean;
  /** O INSERT de crm_proposals colide com o índice único de rascunho (corrida, revisão C3, I4). */
  insercaoColide23505?: boolean;
  /** Fuso lido de organizations.timezone (D8). Default: null (= cai no padrão). */
  fusoDaOrganizacao?: string | null;
  /** Moeda lida de organizations.currency (D11). Default: "BRL". */
  moedaDaOrganizacao?: string;
}

function montarMundoDeProposta(opts: MundoOpts = {}) {
  const papel = opts.papel ?? "agent";
  const propostasCriadas: Record<string, unknown>[] = [];
  const itensCriados: Record<string, unknown>[] = [];
  const propostasExcluidas: string[] = [];

  vi.mocked(requireRole).mockImplementation(async (min: string) => {
    const rank = ROLE_RANK[papel] ?? 0;
    if (rank < (ROLE_RANK[min] ?? 0)) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: { code: "forbidden_role", message: "sem papel" } }), {
          status: 403,
        }),
      } as never;
    }
    return {
      ok: true,
      user: { id: USER_ID, idioma: "pt-BR" },
      org: { orgId: ORG_ID },
    } as never;
  });

  const supabase = {
    from: (tabela: string) => {
      if (tabela === "crm_leads") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: opts.leadPertenceAOutraOrg ? null : { id: LEAD_ID, contact_id: CONTACT_ID },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (tabela === "crm_proposals") {
        return {
          insert: (linha: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                if (opts.insercaoColide23505) return { data: null, error: { code: "23505", message: "colisao" } };
                const id = `proposta-${propostasCriadas.length + 1}`;
                // numero/ano nunca são escritos pela rota — nascem NULL por
                // omissão da coluna, exatamente como o Postgres faria.
                propostasCriadas.push({ numero: null, ano: null, ...linha, id });
                return { data: { id }, error: null };
              },
            }),
          }),
          // Cadeia auto-referente (eq/order/limit sempre devolvem a mesma
          // cadeia, como o builder real do Supabase — que aceita `.eq()`
          // mesmo depois de `.limit()`), e resolve ao ser `await`ada.
          select: () => {
            const filtros: Record<string, unknown> = {};
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cadeia: any = {
              eq(campo: string, valor: unknown) {
                filtros[campo] = valor;
                return cadeia;
              },
              order() {
                return cadeia;
              },
              limit() {
                return cadeia;
              },
              // Pré-checagem de rascunho único (§5.3): select→eq→eq→eq→maybeSingle.
              async maybeSingle() {
                if (filtros.status === "rascunho" && filtros.lead_id) {
                  return opts.rascunhoJaExiste
                    ? { data: { id: RASCUNHO_EXISTENTE_ID }, error: null }
                    : { data: null, error: null };
                }
                const achadas = propostasCriadas.filter((p) =>
                  Object.entries(filtros).every(([c, v]) => c === "organization_id" || p[c] === v),
                );
                return { data: achadas[0] ?? null, error: null };
              },
              then(resolve: (r: { data: unknown[]; error: null }) => void) {
                resolve({
                  data: propostasCriadas.filter((p) =>
                    Object.entries(filtros).every(([c, v]) => c === "organization_id" || p[c] === v),
                  ),
                  error: null,
                });
              },
            };
            return cadeia;
          },
        };
      }
      if (tabela === "catalog_products") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => {
                    const preco = opts.precoDoCatalogo === undefined ? 3000 : opts.precoDoCatalogo;
                    return preco === null
                      ? { data: null, error: null }
                      : { data: { preco_cents: preco, moeda: opts.moedaDoCatalogo ?? "BRL" }, error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      if (tabela === "crm_proposal_items") {
        return {
          insert: async (linhas: Record<string, unknown>[]) => {
            if (opts.itensFalham) return { error: { message: "boom" } };
            itensCriados.push(...linhas);
            return { error: null };
          },
        };
      }
      if (tabela === "crm_lead_activities") {
        return { insert: async () => ({ error: null }) };
      }
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  settings: {
                    proposals: {
                      enabled: false,
                      default_valid_days: 15,
                      default_conditions: opts.condicoesPadrao ?? null,
                    },
                  },
                },
                error: null,
              }),
              // D8 — `fusoDaOrganizacao` lê `timezone` com `maybeSingle`.
              // D11 — `moedaDaOrganizacao` lê `currency` com `maybeSingle`.
              maybeSingle: async () => ({
                data: { timezone: opts.fusoDaOrganizacao ?? null, currency: opts.moedaDaOrganizacao ?? "BRL" },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela não mockada neste teste: ${tabela}`);
    },
  };
  vi.mocked(createClient).mockResolvedValue(supabase as never);
  // A compensação do item que falhou apaga pelo servidor (a RLS da 0464 não
  // deixa `agent` apagar proposta).
  // Sem `delete` no cliente da sessão acima: se a rota voltar a apagar por
  // ele, o teste quebra em vez de passar pelo banco falso.
  vi.mocked(createAdminClient).mockReturnValue({
    from: (tabela: string) => {
      if (tabela !== "crm_proposals") throw new Error(`admin: tabela inesperada ${tabela}`);
      return {
        delete: () => ({
          eq: () => ({
            eq: async (_campo: string, id: string) => {
              propostasExcluidas.push(id);
              return { error: null };
            },
          }),
        }),
      };
    },
  } as never);

  return {
    leadId: LEAD_ID,
    propostasCriadas,
    itensCriados,
    propostasExcluidas,
    async POST(corpo: unknown) {
      const { POST } = await import("./route");
      const res = await POST(pedido(corpo));
      const body = await res.clone().json();
      return { status: res.status, body };
    },
    async GET(query = "") {
      const { GET } = await import("./route");
      const res = await GET(new NextRequest(`http://localhost/api/v1/proposals${query}`));
      const body = await res.clone().json();
      return { status: res.status, body };
    },
  };
}

describe("POST /api/v1/proposals", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("cria com status rascunho, numero/ano nulos, total calculado", async () => {
    const mundo = montarMundoDeProposta();
    const res = await mundo.POST({
      lead_id: mundo.leadId,
      titulo: "Site institucional",
      itens: [
        { product_id: null, descricao: "Site", quantidade: 1, preco_unitario_cents: 800000, desconto_cents: 0, position: 1000 },
      ],
    });
    expect(res.status).toBe(201);
    const criada = mundo.propostasCriadas.at(-1);
    expect(criada?.status).toBe("rascunho");
    expect(criada?.numero).toBeNull();
    expect(criada?.total_cents).toBe(800000);
  });

  it.each([
    ["2026-06-16T23:30:00Z", "2026-07-02"],
    ["2026-03-14T23:30:00Z", "2026-03-29"],
    ["2026-10-11T00:30:00+01:00", "2026-10-26"],
  ])("valid_until omitido: soma 15 dias no calendário da organização a partir de %s (D8)", async (iso, esperado) => {
    // Lisboa já está no dia seguinte no primeiro caso; nos outros dois,
    // o prazo atravessa uma mudança de horário de verão.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(iso));
      const mundo = montarMundoDeProposta({ fusoDaOrganizacao: "Europe/Lisbon" });
      const res = await mundo.POST({
        lead_id: mundo.leadId,
        titulo: "x",
        itens: [
          { product_id: null, descricao: "Site", quantidade: 1, preco_unitario_cents: 800000, desconto_cents: 0, position: 1000 },
        ],
      });
      expect(res.status).toBe(201);
      const criada = mundo.propostasCriadas.at(-1);
      expect(criada?.valid_until).toBe(esperado);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejeita lead de OUTRA organização (422/404, nunca 500 silencioso)", async () => {
    const mundo = montarMundoDeProposta({ leadPertenceAOutraOrg: true });
    const res = await mundo.POST({ lead_id: mundo.leadId, titulo: "x", itens: [] });
    expect([404, 422]).toContain(res.status);
    expect(mundo.propostasCriadas).toHaveLength(0);
  });

  it("papel viewer não cria (403)", async () => {
    const mundo = montarMundoDeProposta({ papel: "viewer" });
    const res = await mundo.POST({ lead_id: mundo.leadId, titulo: "x", itens: [] });
    expect(res.status).toBe(403);
  });

  it("item com product_id: preço vem do catálogo, IGNORA o preço mandado no body (C3/D5)", async () => {
    const mundo = montarMundoDeProposta({ precoDoCatalogo: 3000 });
    const res = await mundo.POST({
      lead_id: mundo.leadId, titulo: "Com catálogo",
      itens: [{ product_id: PRODUCT_ID, descricao: "Ignorado", quantidade: 1, preco_unitario_cents: 999999, desconto_cents: 0, position: 1000 }],
    });
    expect(res.status).toBe(201);
    // total tem que refletir o preço do CATÁLOGO (3000), não o mandado (999999).
    expect(mundo.propostasCriadas.at(-1)).toMatchObject({ total_cents: 3000, pricing_status: "catalog" });
    expect(mundo.itensCriados.at(-1)).toMatchObject({ preco_unitario_cents: 3000 });
  });

  it("product_id que não existe na organização: 422, nada é gravado", async () => {
    const mundo = montarMundoDeProposta({ precoDoCatalogo: null });
    const res = await mundo.POST({
      lead_id: mundo.leadId, titulo: "Produto inexistente",
      itens: [{ product_id: PRODUCT_DE_OUTRA_ORG, descricao: "x", quantidade: 1, preco_unitario_cents: 100, desconto_cents: 0, position: 1000 }],
    });
    expect(res.status).toBe(422);
    expect(mundo.propostasCriadas).toHaveLength(0);
    expect(mundo.itensCriados).toHaveLength(0);
  });

  it("item sem product_id e sem preço: cria como rascunho 'a definir' (pricing_status missing)", async () => {
    const mundo = montarMundoDeProposta();
    const res = await mundo.POST({
      lead_id: mundo.leadId, titulo: "A definir",
      itens: [{ product_id: null, descricao: "x", quantidade: 1, preco_unitario_cents: null, desconto_cents: 0, position: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(mundo.propostasCriadas.at(-1)).toMatchObject({ pricing_status: "missing", total_cents: 0 });
  });

  it("condicoes omitidas no body: usa default_conditions da organização (D7)", async () => {
    const mundo = montarMundoDeProposta({ condicoesPadrao: "Válido por 15 dias corridos." });
    const res = await mundo.POST({ lead_id: mundo.leadId, titulo: "Sem condições no body", itens: [] });
    expect(res.status).toBe(201);
    expect(mundo.propostasCriadas.at(-1)).toMatchObject({ condicoes: "Válido por 15 dias corridos." });
  });

  it("negócio já tem rascunho aberto: 409 com o id do rascunho existente, nada duplicado", async () => {
    const mundo = montarMundoDeProposta({ rascunhoJaExiste: true });
    const res = await mundo.POST({ lead_id: mundo.leadId, titulo: "Duplicado", itens: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.details?.rascunho_aberto_id).toBe(RASCUNHO_EXISTENTE_ID);
    expect(mundo.propostasCriadas).toHaveLength(0);
  });

  it("corrida: dois cliques quase simultâneos — a pré-checagem não pega, mas o índice único (23505) do INSERT devolve 409, não 500 (revisão C3, I4)", async () => {
    const mundo = montarMundoDeProposta({ insercaoColide23505: true });
    const res = await mundo.POST({ lead_id: mundo.leadId, titulo: "x", itens: [] });
    expect(res.status).toBe(409);
    expect(mundo.propostasCriadas).toHaveLength(0);
  });

  it("grava a MOEDA DA ORGANIZAÇÃO na proposta, não sempre BRL (D11)", async () => {
    const mundo = montarMundoDeProposta({ moedaDaOrganizacao: "USD" });
    const res = await mundo.POST({ lead_id: mundo.leadId, titulo: "x", itens: [] });
    expect(res.status).toBe(201);
    expect(mundo.propostasCriadas.at(-1)).toMatchObject({ moeda: "USD" });
  });

  it("item de catálogo em moeda diferente da organização: 422, nada gravado", async () => {
    const mundo = montarMundoDeProposta({ moedaDaOrganizacao: "BRL", moedaDoCatalogo: "USD", precoDoCatalogo: 3000 });
    const res = await mundo.POST({
      lead_id: mundo.leadId, titulo: "x",
      itens: [{ product_id: PRODUCT_ID, descricao: "x", quantidade: 1, preco_unitario_cents: 100, desconto_cents: 0, position: 1000 }],
    });
    expect(res.status).toBe(422);
    expect(mundo.propostasCriadas).toHaveLength(0);
    expect(mundo.itensCriados).toHaveLength(0);
  });

  it("falha ao gravar os itens: a proposta recém-criada é APAGADA, não fica rascunho vazio travando o negócio (revisão C3, I2)", async () => {
    const mundo = montarMundoDeProposta({ itensFalham: true });
    const res = await mundo.POST({
      lead_id: mundo.leadId,
      titulo: "x",
      itens: [{ product_id: null, descricao: "x", quantidade: 1, preco_unitario_cents: 100, desconto_cents: 0, position: 1000 }],
    });
    expect(res.status).toBe(500);
    expect(mundo.propostasExcluidas).toEqual([mundo.propostasCriadas.at(-1)?.id]);
  });
});

describe("GET /api/v1/proposals", () => {
  it("lista só as propostas da organização ativa", async () => {
    const mundo = montarMundoDeProposta();
    const res = await mundo.GET();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("filtra por lead_id quando informado (D10 — tela de excluir negócio)", async () => {
    const mundo = montarMundoDeProposta();
    await mundo.POST({
      lead_id: mundo.leadId, titulo: "do lead", itens: [
        { product_id: null, descricao: "x", quantidade: 1, preco_unitario_cents: 100, desconto_cents: 0, position: 1000 },
      ],
    });
    const res = await mundo.GET(`?lead_id=${mundo.leadId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((p: { lead_id: string }) => p.lead_id === mundo.leadId)).toBe(true);

    const semFiltro = await mundo.GET(`?lead_id=algum-outro-id-que-nao-existe`);
    expect(semFiltro.body.data).toEqual([]);
  });
});

describe("GET /api/v1/proposals — capacidade desligada", () => {
  it("organização com propostas desligadas: 404, sem listar nada", async () => {
    const mundo = montarMundoDeProposta();
    vi.mocked(sePropostasDesligadas).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "not_found", message: "Not found." } }), {
        status: 404,
      }) as never,
    );
    const res = await mundo.GET();
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "not_found" } });
  });
});
