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
  /** A chave `catalogo_por_feed` da instalação. */
  moduloLigado: true,
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
vi.mock("@/lib/instalacao/modulos", () => ({
  moduloLigado: vi.fn(async (_db: unknown, modulo: string) => modulo === "catalogo_por_feed" && estado.moduloLigado),
}));

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
  estado.moduloLigado = true;
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

/**
 * O MÓDULO DESLIGADO, no ponto de execução (doc 322, A).
 *
 * O caso que importa não é "instalação sem fonte" (o portão já cobre): é a
 * empresa que CADASTROU o feed e depois o dono do servidor desligou o módulo. A
 * fonte continua `ativo = true` na tabela, o portão do piso ocioso diz "em uso",
 * e a única coisa entre a batida e a internet é a chave conferida dentro de
 * `sincronizarFontes`. Por isso o teste chama a FUNÇÃO, e não só a rota.
 */
describe("catalog-feed-sync — módulo `catalogo_por_feed` desligado", () => {
  const fonteCadastrada = {
    id: "f-1",
    organization_id: ORG_ID,
    url: "https://revenda.example/feed.json",
    formato: "json",
    mapeamento: {},
    falhas_seguidas: 0,
  };

  it("sincronizarFontes NÃO lê fonte, NÃO busca URL e NÃO escreve — mesmo com fonte ativa cadastrada", async () => {
    estado.moduloLigado = false;
    estado.fontes = [fonteCadastrada];
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: true, texto: "[]" });
    const { sincronizarFontes } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    const resultado = await sincronizarFontes(clienteFalso as never);

    expect(resultado).toBeNull();
    expect(estado.ordem).not.toContain("leitura:fontes");
    expect(vi.mocked(buscarFeedDaUrl)).not.toHaveBeenCalled();
    expect(estado.escritas).toEqual([]);
  });

  it("pela rota: responde `modulo_desligado` e nada sai para a internet", async () => {
    estado.moduloLigado = false;
    estado.portaoOcioso = false;
    estado.fontes = [fonteCadastrada];
    const { GET } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    const res = await GET(pedido());

    expect(res.status).toBe(200);
    expect((await dadosDe(res)).pulado).toBe("modulo_desligado");
    expect(vi.mocked(buscarFeedDaUrl)).not.toHaveBeenCalled();
    expect(estado.escritas).toEqual([]);
  });

  it("controle positivo: LIGADO, a mesma fonte é lida e o feed é buscado", async () => {
    estado.fontes = [fonteCadastrada];
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: true, texto: JSON.stringify([{ id: "SKU-1", nome: "Fone", preco: 10 }]) });
    const { sincronizarFontes } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    const resultado = await sincronizarFontes(clienteFalso as never);

    expect(resultado).toHaveLength(1);
    expect(estado.ordem).toContain("leitura:fontes");
    expect(vi.mocked(buscarFeedDaUrl)).toHaveBeenCalledWith(fonteCadastrada.url);
  });
});

describe("catalog-feed-sync — falha repetida não fica muda", () => {
  const fonte = (falhas: number) => ({
    id: "f-1",
    organization_id: ORG_ID,
    url: "https://ruim.example/feed.json",
    formato: "json",
    mapeamento: {},
    falhas_seguidas: falhas,
  });

  it("a falha fica na fonte, com a conta e o motivo — e não abre aviso antes do limite", async () => {
    estado.fontes = [fonte(0)];
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: false, motivo: "a origem respondeu 500" });
    const { sincronizarFontes } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    await sincronizarFontes(clienteFalso as never);

    const rastro = estado.escritas.find((e) => e.tabela === "catalog_feed_sources" && e.tipo === "update");
    expect(rastro?.valor).toMatchObject({ falhas_seguidas: 1, ultimo_erro: "a origem respondeu 500" });
    expect(estado.escritas.some((e) => e.tabela === "agent_inbox_items")).toBe(false);
  });

  it("a 3ª falha seguida abre UM aviso na Central, da organização da fonte", async () => {
    estado.fontes = [fonte(2)];
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: false, motivo: "a origem respondeu 500" });
    const { sincronizarFontes, LIMITE_DE_FALHAS } = await import("@/app/api/v1/cron/catalog-feed-sync/route");
    expect(LIMITE_DE_FALHAS).toBe(3);

    await sincronizarFontes(clienteFalso as never);

    const avisos = estado.escritas.filter((e) => e.tabela === "agent_inbox_items" && e.tipo === "insert");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.valor).toMatchObject({ organization_id: ORG_ID, kind: "other", ref_kind: "catalog_feed_source", ref_id: "f-1" });
  });

  it("a 4ª falha não abre outro aviso (um por sequência, não um por batida)", async () => {
    estado.fontes = [fonte(3)];
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: false, motivo: "a origem respondeu 500" });
    const { sincronizarFontes } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    await sincronizarFontes(clienteFalso as never);

    expect(estado.escritas.some((e) => e.tabela === "agent_inbox_items" && e.tipo === "insert")).toBe(false);
  });

  it("a primeira leitura que dá certo zera a conta e resolve o aviso", async () => {
    estado.fontes = [{ ...fonte(4), url: "https://boa.example/feed.json" }];
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: true, texto: JSON.stringify([{ id: "SKU-1", nome: "Fone", preco: 10 }]) });
    const { sincronizarFontes } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    await sincronizarFontes(clienteFalso as never);

    const rastro = estado.escritas.find((e) => e.tabela === "catalog_feed_sources" && e.tipo === "update");
    expect(rastro?.valor).toMatchObject({ falhas_seguidas: 0, ultimo_erro: null });
    const resolvido = estado.escritas.find((e) => e.tabela === "agent_inbox_items" && e.tipo === "update");
    expect(resolvido?.valor).toMatchObject({ status: "resolved" });
  });
});

describe("catalog-feed-sync — o teto proporcional é FALHA da rodada", () => {
  it("feed que tiraria mais da metade de linha: nada é escrito no catálogo, e a falha conta para o aviso", async () => {
    estado.fontes = [
      { id: "f-1", organization_id: ORG_ID, url: "https://revenda.example/feed.json", formato: "json", mapeamento: {}, falhas_seguidas: 2 },
    ];
    estado.produtos = Array.from({ length: 12 }, (_, i) => ({
      id: `p-${i}`,
      id_externo: `SKU-${i}`,
      nome: `Item ${i}`,
      descricao: null,
      preco_cents: 100_000,
      fotos: null,
      quantidade: 0,
      ativo: true,
    }));
    // Só 2 dos 12 continuam no feed: 10 sairiam de linha.
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({
      ok: true,
      texto: JSON.stringify([
        { id: "SKU-0", nome: "Item 0", preco: "1.000,00" },
        { id: "SKU-1", nome: "Item 1", preco: "1.000,00" },
      ]),
    });
    const { sincronizarFontes } = await import("@/app/api/v1/cron/catalog-feed-sync/route");

    const [resultado] = (await sincronizarFontes(clienteFalso as never))!;

    expect(resultado!.falhou).toContain("10 de 12");
    expect(estado.escritas.filter((e) => e.tabela === "catalog_products")).toEqual([]);
    const rastro = estado.escritas.find((e) => e.tabela === "catalog_feed_sources" && e.tipo === "update");
    expect(rastro?.valor).toMatchObject({ falhas_seguidas: 3 });
    expect(estado.escritas.some((e) => e.tabela === "agent_inbox_items" && e.tipo === "insert")).toBe(true);
  });
});
