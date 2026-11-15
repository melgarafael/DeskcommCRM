import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as PisoOcioso from "@/lib/cron/piso-ocioso";

/**
 * O CRON `catalog-feed-sync` — o portão vem ANTES de qualquer leitura.
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * Instalação sem revenda com feed é o caso NORMAL: a maioria não tem fonte
 * nenhuma. Uma batida a cada 2 h que só descobre isso DEPOIS de consultar o
 * PostgREST é exatamente o custo que o #3731 mediu (piso ocioso): requisição
 * vazia, cota do Supabase consumida, nada feito.
 *
 * A ordem é o que se cobra aqui, e não só "o portão foi chamado": um `if` que
 * rodasse depois da leitura economizaria zero. O registro de ordem é feito pelo
 * PRÓPRIO mock do portão e pelo cliente falso — quem chegar primeiro escreve
 * primeiro.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";

const estado = vi.hoisted(() => ({
  /** Toda ida ao banco, na ordem em que aconteceu. */
  ordem: [] as string[],
  escritas: [] as { tabela: string; tipo: string; valor: unknown }[],
  fontes: [] as unknown[],
  produtos: [] as unknown[],
  portaoOcioso: true,
}));

function cadeia(tabela: string) {
  const passo: Record<string, unknown> = {};
  const registrar = (tipo: string) => (valor?: unknown) => {
    if (tipo === "insert" || tipo === "update" || tipo === "delete" || tipo === "upsert") {
      estado.escritas.push({ tabela, tipo, valor });
    }
    if (tabela === "catalog_feed_sources" && tipo === "select") estado.ordem.push("leitura:fontes");
    return passo;
  };
  for (const verbo of ["select", "insert", "update", "delete", "upsert", "order", "in", "is", "not", "neq", "limit"]) {
    passo[verbo] = registrar(verbo);
  }
  passo.eq = () => passo;
  passo.single = async () => ({ data: null, error: null });
  passo.maybeSingle = async () => ({ data: null, error: null });
  passo.then = (resolve: (v: unknown) => unknown) => {
    if (tabela === "catalog_feed_sources") return Promise.resolve({ data: estado.fontes, error: null }).then(resolve);
    // A régua da organização operante lê `organizations` numa rodada com fonte:
    // nenhuma org parada neste duplo, e a lista vazia é o que ela devolve.
    if (tabela === "organizations") return Promise.resolve({ data: [], error: null }).then(resolve);
    return Promise.resolve({ data: estado.produtos, error: null }).then(resolve);
  };
  return passo;
}

const clienteFalso = { from: (tabela: string) => cadeia(tabela) };

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: vi.fn(async () => "BRL") }));
vi.mock("@/lib/catalogo/feed-remoto", () => ({ buscarFeedDaUrl: vi.fn() }));

/**
 * O portão REAL é substituído por um que REGISTRA a ordem — é o único jeito de
 * provar "antes de qualquer leitura": o portão de verdade consulta o pool `pg`,
 * não o PostgREST, e a ordem entre os dois não apareceria no cliente falso.
 */
vi.mock("@/lib/cron/piso-ocioso", async (importOriginal) => {
  const original = await importOriginal<typeof PisoOcioso>();
  return {
    ...original,
    recursoOcioso: vi.fn(async () => {
      estado.ordem.push("portao");
      return estado.portaoOcioso;
    }),
  };
});

import { buscarFeedDaUrl } from "@/lib/catalogo/feed-remoto";

const pedido = () => new NextRequest("http://localhost/api/v1/cron/catalog-feed-sync", { method: "GET" });
const dadosDe = async (res: Response) => ((await res.json()) as { data: Record<string, unknown> }).data;

beforeEach(() => {
  vi.clearAllMocks();
  estado.ordem = [];
  estado.escritas = [];
  estado.fontes = [];
  estado.produtos = [];
  estado.portaoOcioso = true;
  PisoOcioso.esquecerRetrato();
});

afterEach(() => PisoOcioso.esquecerRetrato());

describe("GET /api/v1/cron/catalog-feed-sync — o portão", () => {
  it("recurso ocioso: sai cedo e NÃO faz leitura nenhuma no banco", async () => {
    estado.fontes = [];
    const { GET } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    const res = await GET(pedido());
    const dados = await dadosDe(res);

    expect(res.status).toBe(200);
    expect(dados.pulado).toBe("recurso_ocioso");
    // Zero ida ao banco — nem para descobrir que não há fonte.
    expect(estado.ordem).toEqual(["portao"]);
    expect(estado.escritas).toEqual([]);
  });

  it("recurso em uso: a primeira coisa que acontece é o portão, e a rodada RODA", async () => {
    estado.portaoOcioso = false;
    estado.fontes = [];
    const { GET } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    const res = await GET(pedido());
    const dados = await dadosDe(res);

    expect(res.status).toBe(200);
    expect(dados.pulado).toBeUndefined();
    expect(estado.ordem[0]).toBe("portao");
    expect(estado.ordem).toContain("leitura:fontes");
  });
});

describe("GET /api/v1/cron/catalog-feed-sync — a rodada", () => {
  it("sincroniza a fonte ativa: cria, atualiza e desativa sem apagar", async () => {
    estado.portaoOcioso = false;
    estado.fontes = [
      {
        organization_id: ORG_ID,
        url: "https://revenda.example/feed.json",
        formato: "json",
        mapeamento: {},
      },
    ];
    estado.produtos = [
      {
        id: "p-1",
        id_externo: "SKU-1",
        nome: "Fone",
        descricao: null,
        preco_cents: 100_000,
        fotos: null,
        quantidade: 0,
        ativo: true,
      },
      {
        id: "p-9",
        id_externo: "SKU-9",
        nome: "Sumiu",
        descricao: null,
        preco_cents: 5_000,
        fotos: null,
        quantidade: 0,
        ativo: true,
      },
    ];
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({
      ok: true,
      texto: JSON.stringify([
        { id: "SKU-1", nome: "Fone", preco: "1.200,00" },
        { id: "SKU-2", nome: "Carregador", preco: 89.9 },
      ]),
    });

    const { GET } = await import("@/app/api/v1/cron/catalog-feed-sync/route");
    const res = await GET(pedido());
    const dados = (await dadosDe(res)) as { fontes: { criados: number; atualizados: number; desativados: number }[] };

    expect(dados.fontes[0]).toMatchObject({ criados: 1, atualizados: 1, desativados: 1 });
    expect(estado.escritas.filter((e) => e.tipo === "delete")).toEqual([]);
    expect(estado.escritas.some((e) => e.tipo === "update" && (e.valor as { ativo?: boolean }).ativo === false)).toBe(true);
  });

  it("fonte com defeito não desfaz as outras", async () => {
    estado.portaoOcioso = false;
    estado.fontes = [
      { organization_id: ORG_ID, url: "https://ruim.example/feed.json", formato: "json", mapeamento: {} },
      { organization_id: "33333333-3333-4333-8333-333333333333", url: "https://boa.example/feed.json", formato: "json", mapeamento: {} },
    ];
    vi.mocked(buscarFeedDaUrl).mockImplementation(async (url: string) => {
      if (url.includes("ruim")) return { ok: false, motivo: "a origem respondeu 500" };
      return { ok: true, texto: JSON.stringify([{ id: "SKU-2", nome: "Carregador", preco: 89.9 }]) };
    });

    const { GET } = await import("@/app/api/v1/cron/catalog-feed-sync/route");
    const res = await GET(pedido());
    const dados = (await dadosDe(res)) as { fontes: { falhou?: string; criados: number }[] };

    expect(dados.fontes).toHaveLength(2);
    expect(dados.fontes[0]!.falhou).toContain("500");
    expect(dados.fontes[1]).toMatchObject({ criados: 1 });
  });
});
