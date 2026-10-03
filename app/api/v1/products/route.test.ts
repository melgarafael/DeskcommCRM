import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** O que a rota mandou para o `insert` — é sobre isto que as asserções falam. */
let inserido: Record<string, unknown> | null = null;
/** O org id que o `.eq()` de `organizations` recebeu — o alvo do hallazgo 4. */
let orgIdLido: string | null = null;

/**
 * Supabase de mentira com as DUAS tabelas que a rota toca: lê a moeda em
 * `organizations` e grava em `catalog_products`.
 */
function supabaseCom(moedaDaOrg: string | null) {
  return {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: (_coluna: string, valor: string) => {
              orgIdLido = valor;
              return {
                maybeSingle: async () => ({
                  data: moedaDaOrg === null ? null : { currency: moedaDaOrg },
                  error: null,
                }),
              };
            },
          }),
        };
      }
      return {
        insert: (linha: Record<string, unknown>) => {
          inserido = linha;
          return {
            select: () => ({
              single: async () => ({ data: { id: "p1", ...linha }, error: null }),
            }),
          };
        },
      };
    },
  };
}

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/products", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const PRODUTO = { codigo: "IP15", nome: "iPhone 15", preco_cents: 549900 };

beforeEach(() => {
  vi.clearAllMocks();
  inserido = null;
  orgIdLido = null;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/products — a moeda vem da organização", () => {
  /**
   * ⚠️ SABOTAGEM. A moeda do corpo não decide, pela mesma razão que o
   * `organization_id` do corpo não decide (CLAUDE.md, multi-tenancy): quem
   * escolhe unidade e escopo é a fonte confiável, nunca o cliente. Sem esta
   * guarda, uma chamada direta à API grava um produto em USD num catálogo que
   * a organização declarou em BRL — e o agente cota esse número ao cliente.
   */
  it("ignora a moeda que vem no corpo", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("BRL") as never);
    const { POST } = await import("./route");

    const resposta = await POST(pedido({ ...PRODUTO, moeda: "USD" }));

    expect(resposta.status).toBe(201);
    expect(inserido).toMatchObject({ moeda: "BRL" });
    // O scope também vem de fonte confiável, nunca do body — o mock não pode
    // só provar "moeda ignorada" enquanto deixa passar um `organization_id`
    // vazado, que é a MESMA classe de bug (CLAUDE.md, multi-tenancy).
    expect(orgIdLido).toBe(ORG_ID);
  });

  /**
   * ⚠️ TESTE DISCRIMINANTE. O caso acima sozinho passa VERDE com a moeda
   * chumbada em 'BRL' — que é exatamente o defeito que este PR conserta. Só a
   * organização em MXN prova que a rota foi LER a coluna.
   */
  it("grava a moeda que a organização declarou, não o padrão", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("MXN") as never);
    const { POST } = await import("./route");

    const resposta = await POST(pedido({ ...PRODUTO, moeda: "USD" }));

    expect(resposta.status).toBe(201);
    expect(inserido).toMatchObject({ moeda: "MXN" });
    expect(orgIdLido).toBe(ORG_ID);
  });

  /**
   * A leitura da organização pode falhar (linha some, RLS nega). `moedaDaOrganizacao()`
   * escreve `MOEDA_PADRAO` ('BRL') EXPLÍCITO no insert — não é o `default` da
   * coluna que decide, porque a rota manda um valor no corpo do insert de
   * qualquer forma. O nome deste teste dizia o contrário antes da revisão: o
   * `default` da coluna nunca chega a ser exercitado por este caminho.
   */
  it("cai na moeda padrão quando a organização não responde, escrita explícita", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom(null) as never);
    const { POST } = await import("./route");

    const resposta = await POST(pedido({ ...PRODUTO, moeda: "USD" }));

    expect(resposta.status).toBe(201);
    expect(inserido).toMatchObject({ moeda: "BRL" });
    expect(orgIdLido).toBe(ORG_ID);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

// ─── GET: busca no servidor e paginação opcional ───────────────────────────

/** As chamadas que a rota fez no construtor de consulta — o alvo das asserções. */
interface ConsultaGravada {
  selectOpts: unknown;
  or: string[];
  range: [number, number] | null;
  limit: number | null;
}
let consulta: ConsultaGravada;

function supabaseDeLeitura(linhas: unknown[], total: number) {
  consulta = { selectOpts: undefined, or: [], range: null, limit: null };
  const resultado = { data: linhas, error: null, count: total };
  const construtor = {
    eq: () => construtor,
    or: (f: string) => {
      consulta.or.push(f);
      return construtor;
    },
    order: () => construtor,
    range: async (de: number, ate: number) => {
      consulta.range = [de, ate];
      return resultado;
    },
    limit: async (n: number) => {
      consulta.limit = n;
      return resultado;
    },
  };
  return {
    from: () => ({
      select: (_colunas: string, opts?: unknown) => {
        consulta.selectOpts = opts;
        return construtor;
      },
    }),
  };
}

function listar(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/products${qs}`, { method: "GET" });
}

describe("GET /api/v1/products — o catálogo inteiro, não os 500 primeiros", () => {
  it("sem `pagina`, responde como sempre: até 500 linhas e sem `meta`", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeLeitura([{ id: "p1" }], 1) as never);
    const { GET } = await import("./route");

    const res = await GET(listar(""));
    const corpo = await res.json();

    expect(consulta.limit).toBe(500);
    expect(consulta.range).toBeNull();
    expect(corpo.meta).toBeUndefined();
  });

  it("com `pagina=3`, pede ao banco a terceira fatia de 50 e devolve o total", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeLeitura([{ id: "p1" }], 4412) as never);
    const { GET } = await import("./route");

    const res = await GET(listar("?pagina=3"));
    const corpo = await res.json();

    expect(consulta.range).toEqual([100, 149]);
    expect(consulta.selectOpts).toEqual({ count: "exact" });
    expect(corpo.meta).toMatchObject({ total: 4412, pagina: 3, por_pagina: 50, has_more: true });
  });

  it("a busca com vírgula não injeta condição no `.or()`", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeLeitura([], 0) as never);
    const { GET } = await import("./route");

    await GET(listar(`?busca=${encodeURIComponent("pistola,ativo.eq.false")}`));

    // Quatro colunas, quatro condições — nenhuma vinda do texto digitado.
    expect(consulta.or).toHaveLength(1);
    expect(consulta.or[0]?.split(",")).toHaveLength(4);
  });

  // O banco do mock TEM produto: se a rota consultar sem filtro, `data` volta
  // cheio. Medir só a ausência do `.or()` deixava passar justamente isso — o
  // catálogo inteiro no seletor da proposta, que busca a cada tecla.
  it.each(["c", ", ,", "()"])(
    "termo abaixo do piso (%j) devolve lista vazia, sem ir ao banco — como a busca de contatos",
    async (termo) => {
      vi.mocked(createClient).mockResolvedValue(supabaseDeLeitura([{ id: "p1" }], 1) as never);
      const { GET } = await import("./route");

      const res = await GET(listar(`?busca=${encodeURIComponent(termo)}`));
      const corpo = await res.json();

      expect(corpo.data).toEqual([]);
      expect(consulta.limit).toBeNull();
      expect(consulta.range).toBeNull();
    },
  );

  it("termo abaixo do piso com `pagina` devolve lista vazia COM `meta`", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeLeitura([{ id: "p1" }], 1) as never);
    const { GET } = await import("./route");

    const res = await GET(listar("?busca=c&pagina=2"));
    const corpo = await res.json();

    expect(corpo.data).toEqual([]);
    expect(corpo.meta).toEqual({ total: 0, pagina: 2, por_pagina: 50, has_more: false });
  });
});

describe("GET /api/v1/products — página além da última", () => {
  /**
   * O PostgREST responde 416 `PGRST103` quando o `range` começa depois do
   * total (medido contra o Supabase local). A contagem que a rota faz em
   * seguida é um `head` sem linhas, que resolve direto na consulta.
   */
  function supabaseAlemDoFim(totalAgora: number) {
    const contagem = {
      eq: () => contagem,
      or: () => contagem,
      then: (resolve: (v: unknown) => void) => resolve({ count: totalAgora, error: null }),
    };
    const listagem = {
      eq: () => listagem,
      or: () => listagem,
      order: () => listagem,
      range: async () => ({
        data: null,
        count: null,
        error: { code: "PGRST103", message: "Requested range not satisfiable" },
      }),
    };
    return {
      from: () => ({
        select: (_c: string, opts?: { head?: boolean }) => (opts?.head ? contagem : listagem),
      }),
    };
  }

  it("devolve lista vazia com o total de agora, não erro 500", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseAlemDoFim(529) as never);
    const { GET } = await import("./route");

    const res = await GET(listar("?pagina=99"));
    const corpo = await res.json();

    expect(res.status).toBe(200);
    expect(corpo.data).toEqual([]);
    expect(corpo.meta).toMatchObject({ total: 529, pagina: 99, has_more: false });
  });
});
