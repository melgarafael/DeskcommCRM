import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { buscarFeedDaUrl } from "@/lib/catalogo/feed-remoto";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/v1/products/feed — a EMPRESA na pergunta do módulo (#4871).
 *
 * ─── O defeito que este arquivo existe para impedir ─────────────────────────
 *
 * A rota é a INTERFACE da fonte de catálogo: é por ela que a revenda publica o
 * estoque e o preço que a IA responde. Até aqui ela perguntava
 * `moduloLigado(db, "catalogo_por_feed")`, SEM empresa — então a linha
 * `desligado` de `organization_modules` era ignorada: a empresa que desligou o
 * módulo continuava publicando pela tela e gravando preço, enquanto o cron que
 * a rota alimenta (`catalog-feed-sync`) já recusava a fonte dela desde o #4969.
 * Duas respostas para a mesma chave, no mesmo módulo.
 *
 * ─── Por que a decisão é a REAL, e não um duplo ──────────────────────────────
 *
 * `lib/instalacao/modulos` NÃO é mockado aqui. O mock cobraria "a rota passou a
 * organização" e passaria mesmo que `MODULOS_POR_EMPRESA` não tivesse
 * `catalogo_por_feed` — que é exatamente o estado da main antes do #4969, onde
 * passar a empresa é NO-OP. Com a função de verdade e um cliente falso que
 * responde `platform_config` e `organization_modules`, o caso da empresa
 * desligada só fica verde quando a camada por empresa conhece este módulo: o
 * teste mede a dependência em vez de declará-la.
 *
 * Os cinco pontos do piso, todos por rodada INTEIRA de request:
 *  1. instalação desligada recusa — antes até de resolver a empresa;
 *  2. empresa desligada recusa com o MESMO código da instalação desligada (404,
 *     não um 403 novo);
 *  3. empresa com linha `ligado` passa e escreve os DOIS pontos (produto e fonte);
 *  4. empresa SEM linha herda a instalação;
 *  5. leitura da empresa ilegível NEGA (falha fechada).
 * E o controle de multi-tenant: a linha de OUTRA empresa não decide esta.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";

const estado = vi.hoisted(() => ({
  escritas: [] as { tabela: string; tipo: string; valor: unknown }[],
  /** Toda tabela LIDA, para provar o que a recusa não chegou a tocar. */
  leituras: [] as string[],
  produtos: [] as unknown[],
  /** A chave `MODULO_CATALOGO_POR_FEED` em `platform_config`. */
  instalacao: "ligado" as "ligado" | "desligado",
  /** `organization_modules`: empresa → estado da linha. */
  empresas: {} as Record<string, "ligado" | "desligado">,
  /** A leitura da camada por empresa falhou (RLS, tabela fora do ar). */
  leituraDaEmpresaFalhou: false,
}));

const LINHAS: Record<string, () => { data: unknown; error: unknown }> = {
  platform_config: () => ({
    data: [{ chave: "MODULO_CATALOGO_POR_FEED", valor: estado.instalacao }],
    error: null,
  }),
  organization_modules: () =>
    estado.leituraDaEmpresaFalhou
      ? { data: null, error: { code: "42501", message: "permission denied for table organization_modules" } }
      : {
          data: Object.entries(estado.empresas).map(([organization_id, linha]) => ({
            organization_id,
            modulo: "catalogo_por_feed",
            estado: linha,
          })),
          error: null,
        },
  modulos_instalados: () => ({ data: [], error: null }),
  catalog_feed_sources: () => ({ data: [], error: null }),
  agent_inbox_items: () => ({ data: [], error: null }),
  catalog_products: () => ({ data: estado.produtos, error: null }),
};

/** Cliente de mentira: conta ESCRITAS, anota LEITURAS e responde as chaves de módulo. */
function cadeia(tabela: string) {
  const passo: Record<string, unknown> = {};
  /** O `organization_id` que a consulta pediu — a linha é filtrada por ele. */
  let orgPedida: string | null = null;

  const registrar = (tipo: string) => (valor?: unknown) => {
    if (tipo === "insert" || tipo === "update" || tipo === "delete" || tipo === "upsert") {
      estado.escritas.push({ tabela, tipo, valor });
    }
    if (tipo === "select") estado.leituras.push(tabela);
    return passo;
  };
  for (const verbo of ["select", "insert", "update", "delete", "upsert", "in", "order", "limit", "is", "not"]) {
    passo[verbo] = registrar(verbo);
  }
  passo.eq = (coluna: string, valor: unknown) => {
    if (coluna === "organization_id") orgPedida = valor as string;
    return passo;
  };
  passo.single = async () => ({ data: null, error: null });
  passo.maybeSingle = async () => ({ data: null, error: null });
  passo.then = (resolve: (v: unknown) => unknown) => {
    const resposta = (LINHAS[tabela] ?? (() => ({ data: [], error: null })))();
    // O PostgREST filtra no servidor: a linha de OUTRA empresa não pode voltar
    // numa consulta `.eq("organization_id", ...)`, e o duplo faz o mesmo.
    if (tabela === "organization_modules" && orgPedida !== null && Array.isArray(resposta.data)) {
      const filtradas = (resposta.data as { organization_id: string }[]).filter(
        (linha) => linha.organization_id === orgPedida,
      );
      return Promise.resolve({ ...resposta, data: filtradas }).then(resolve);
    }
    return Promise.resolve(resposta).then(resolve);
  };
  return passo;
}

const clienteFalso = { from: (tabela: string) => cadeia(tabela) };

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => clienteFalso }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/catalogo/feed-remoto", () => ({ buscarFeedDaUrl: vi.fn() }));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: vi.fn(async () => "BRL") }));
vi.mock("@/lib/catalogo/fotos-por-url", () => ({
  guardarFotosPorUrl: vi.fn(async ({ produtoId, urls }: { produtoId: string; urls: string[] }) => ({
    ok: true,
    caminhos: urls.map((url: string, i: number) => `${ORG_ID}/${produtoId}/${i}-${url.split("/").pop()}`),
  })),
}));
vi.mock("@/lib/catalogo/fotos-no-bucket", () => ({ apagarDoBucket: vi.fn(async () => undefined) }));

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/products/feed", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

const ITENS = [
  { id: "SKU-1", nome: "Fone Bluetooth", preco: "1.200,00" },
  { id: "SKU-2", nome: "Carregador turbo", preco: 89.9 },
];

const existente = {
  id: "p-existente",
  id_externo: "SKU-1",
  nome: "Fone Bluetooth",
  descricao: null,
  preco_cents: 100_000,
  fotos: null,
  quantidade: 0,
  ativo: true,
};

/** Aplicar pela URL: exercita os DOIS pontos de escrita (produto e fonte). */
const aplicarPelaUrl = { url: "https://revenda.example/feed.json", dry_run: false };

const escritasEm = (tabela: string) => estado.escritas.filter((e) => e.tabela === tabela);

beforeEach(() => {
  vi.clearAllMocks();
  estado.escritas = [];
  estado.leituras = [];
  estado.produtos = [existente];
  estado.instalacao = "ligado";
  estado.empresas = {};
  estado.leituraDaEmpresaFalhou = false;

  vi.mocked(createClient).mockResolvedValue(clienteFalso as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: true, texto: JSON.stringify(ITENS) });
});

describe("POST /api/v1/products/feed — o módulo pela EMPRESA (#4871)", () => {
  it("instalação desligada: 404 antes de resolver a empresa, nada lido nem buscado", async () => {
    estado.instalacao = "desligado";
    estado.empresas = { [ORG_ID]: "ligado" };
    const { POST } = await import("@/app/api/v1/products/feed/route");

    const res = await POST(pedido(aplicarPelaUrl));

    expect(res.status).toBe(404);
    expect(vi.mocked(requireRole)).not.toHaveBeenCalled();
    expect(vi.mocked(buscarFeedDaUrl)).not.toHaveBeenCalled();
    expect(estado.leituras).not.toContain("catalog_products");
    expect(estado.escritas).toEqual([]);
  });

  it("empresa desligada: MESMO 404 da instalação desligada — não um 403 novo — e os dois pontos de escrita intocados", async () => {
    // O código de referência é o que a rota já usa: instalação desligada.
    estado.instalacao = "desligado";
    const { POST } = await import("@/app/api/v1/products/feed/route");
    const daInstalacao = await POST(pedido(aplicarPelaUrl));
    const codigoDaInstalacao = ((await daInstalacao.json()) as { error: { code: string } }).error.code;

    estado.instalacao = "ligado";
    estado.empresas = { [ORG_ID]: "desligado" };
    estado.escritas = [];
    estado.leituras = [];
    const res = await POST(pedido(aplicarPelaUrl));
    const corpo = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(daInstalacao.status);
    expect(res.status).toBe(404);
    expect(codigoDaInstalacao).toBe("not_found");
    expect(corpo.error.code).toBe(codigoDaInstalacao);
    // A recusa não pode ser confundida com falta de papel: 403 continua sendo 403.
    expect(res.status).not.toBe(403);
    // Nem busca a URL, nem lê o catálogo, nem toca em produto ou fonte.
    expect(vi.mocked(buscarFeedDaUrl)).not.toHaveBeenCalled();
    expect(estado.leituras).not.toContain("catalog_products");
    expect(estado.leituras).not.toContain("catalog_feed_sources");
    expect(escritasEm("catalog_products")).toEqual([]);
    expect(escritasEm("catalog_feed_sources")).toEqual([]);
    expect(estado.escritas).toEqual([]);
  });

  it("empresa com linha `ligado`: passa e escreve produto E fonte", async () => {
    estado.empresas = { [ORG_ID]: "ligado" };
    const { POST } = await import("@/app/api/v1/products/feed/route");

    const res = await POST(pedido(aplicarPelaUrl));

    expect(res.status).toBe(200);
    expect(vi.mocked(buscarFeedDaUrl)).toHaveBeenCalledWith(aplicarPelaUrl.url);
    expect(escritasEm("catalog_products").some((e) => e.tipo === "insert")).toBe(true);
    const fonte = escritasEm("catalog_feed_sources").find((e) => e.tipo === "upsert");
    expect(fonte?.valor).toMatchObject({ organization_id: ORG_ID, url: aplicarPelaUrl.url });
  });

  it("empresa SEM linha: herda a instalação ligada e passa", async () => {
    estado.empresas = {};
    const { POST } = await import("@/app/api/v1/products/feed/route");

    const res = await POST(pedido(aplicarPelaUrl));

    expect(res.status).toBe(200);
    expect(escritasEm("catalog_products").length).toBeGreaterThan(0);
    expect(escritasEm("catalog_feed_sources").some((e) => e.tipo === "upsert")).toBe(true);
  });

  it("leitura da empresa ilegível: NEGA — falha fechada, sem busca e sem escrita", async () => {
    estado.leituraDaEmpresaFalhou = true;
    const { POST } = await import("@/app/api/v1/products/feed/route");

    const res = await POST(pedido(aplicarPelaUrl));

    expect(res.status).toBe(404);
    expect(vi.mocked(buscarFeedDaUrl)).not.toHaveBeenCalled();
    expect(estado.escritas).toEqual([]);
  });

  it("a linha de OUTRA empresa não decide esta: quem manda é a organização do cookie", async () => {
    estado.empresas = { [OUTRA_ORG]: "desligado" };
    const { POST } = await import("@/app/api/v1/products/feed/route");

    const res = await POST(pedido(aplicarPelaUrl));

    expect(res.status).toBe(200);
    expect(escritasEm("catalog_products").some((e) => e.tipo === "insert")).toBe(true);
  });
});
