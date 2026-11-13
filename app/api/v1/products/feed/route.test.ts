import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { buscarFeedDaUrl } from "@/lib/catalogo/feed-remoto";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/v1/products/feed — a INTERFACE da fonte de catálogo.
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 * `lib/catalogo/feed.test.ts` prova a REGRA (o plano). Aqui se prova o que a
 * regra não pode provar sozinha, e que é onde o defeito mora:
 *
 *  1. `dry_run` NÃO escreve — nem produto, nem fonte. Mock conta ZERO insert,
 *     update, delete e upsert;
 *  2. aplicar DESATIVA, não apaga: o UPDATE com `ativo = false` acontece e não
 *     existe DELETE em lugar nenhum;
 *  3. sem papel `manager` a rota responde 403 e não escreve nada;
 *  4. a organização vem do COOKIE: um `organization_id` no corpo é ignorado.
 *
 * O quarto é a mesma classe de bug que o teste da rota de produto avulso cobra
 * (CLAUDE.md, multi-tenancy): aceitar o escopo do corpo é escrever no catálogo
 * de outra loja com o papel de `manager` da própria.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const estado = vi.hoisted(() => ({
  escritas: [] as { tabela: string; tipo: string; valor: unknown }[],
  /** Os `organization_id` que a rota passou em algum `.eq()`. */
  equais: [] as [string, unknown][],
  produtos: [] as unknown[],
}));

/** Cliente de mentira: conta ESCRITAS e devolve as linhas combinadas na leitura. */
function cadeia(tabela: string) {
  const passo: Record<string, unknown> = {};
  const registrar = (tipo: string) => (valor?: unknown) => {
    if (tipo === "insert" || tipo === "update" || tipo === "delete" || tipo === "upsert") {
      estado.escritas.push({ tabela, tipo, valor });
    }
    return passo;
  };
  for (const verbo of ["select", "insert", "update", "delete", "upsert", "in", "order", "limit", "is", "not"]) {
    passo[verbo] = registrar(verbo);
  }
  passo.eq = (coluna: string, valor: unknown) => {
    estado.equais.push([coluna, valor]);
    return passo;
  };
  passo.single = async () => ({ data: null, error: null });
  passo.maybeSingle = async () => ({ data: null, error: null });
  // Qualquer `await` sobre a cadeia resolve com a leitura combinada.
  passo.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: estado.produtos, error: null }).then(resolve);
  return passo;
}

const clienteFalso = { from: (tabela: string) => cadeia(tabela) };

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
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

const ITENS = [
  // existe, preço novo
  { id: "SKU-1", nome: "Fone Bluetooth", preco: "1.200,00" },
  // novo
  { id: "SKU-2", nome: "Carregador turbo", preco: 89.9 },
];

/** O produto que sumiu do feed — precisa ser DESATIVADO, e continuar na tabela. */
const SUMIU = {
  ...existente,
  id: "p-sumiu",
  id_externo: "SKU-9",
  nome: "Capa antiga",
};

beforeEach(() => {
  vi.clearAllMocks();
  estado.escritas = [];
  estado.equais = [];
  estado.produtos = [existente, SUMIU];
  vi.mocked(createClient).mockResolvedValue(clienteFalso as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(moedaDaOrganizacao).mockResolvedValue("BRL");
});

describe("POST /api/v1/products/feed — dry_run", () => {
  it("devolve o plano e NÃO escreve nada", async () => {
    const { POST } = await import("./route");

    const res = await POST(pedido({ itens: ITENS }));
    const corpo = (await res.json()) as { data: { aplicado: boolean; resumo: Record<string, number> } };

    expect(res.status).toBe(200);
    expect(corpo.data.aplicado).toBe(false);
    expect(corpo.data.resumo).toMatchObject({ criar: 1, atualizar: 1, desativar: 1, inalterados: 0 });
    // A prova do critério: nenhuma escrita de qualquer tipo.
    expect(estado.escritas).toEqual([]);
  });

  it("dry_run com URL também não grava a fonte", async () => {
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: true, texto: JSON.stringify(ITENS) });
    const { POST } = await import("./route");

    const res = await POST(pedido({ url: "https://revenda.example/feed.json" }));

    expect(res.status).toBe(200);
    expect(estado.escritas).toEqual([]);
  });
});

describe("POST /api/v1/products/feed — aplicar", () => {
  it("cria, atualiza e DESATIVA (nunca apaga)", async () => {
    const { POST } = await import("./route");

    const res = await POST(pedido({ itens: ITENS, dry_run: false }));
    const corpo = (await res.json()) as { data: { aplicado: boolean; resumo: Record<string, number> } };

    expect(res.status).toBe(200);
    expect(corpo.data.aplicado).toBe(true);
    expect(corpo.data.resumo).toMatchObject({ criados: 1, atualizados: 1, desativados: 1 });

    const inserts = estado.escritas.filter((e) => e.tipo === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.valor).toMatchObject({ id_externo: "SKU-2", origem: "feed", organization_id: ORG_ID });

    // O desfecho do que saiu do feed é UPDATE com `ativo = false`…
    const desativacao = estado.escritas.find(
      (e) => e.tipo === "update" && (e.valor as { ativo?: boolean }).ativo === false,
    );
    expect(desativacao).toBeDefined();
    // …e NÃO existe DELETE em lugar nenhum: a linha fica para a conversa e a
    // proposta que apontam para ela.
    expect(estado.escritas.filter((e) => e.tipo === "delete")).toEqual([]);
  });

  it("guarda a fonte quando veio por URL", async () => {
    vi.mocked(buscarFeedDaUrl).mockResolvedValue({ ok: true, texto: JSON.stringify(ITENS) });
    const { POST } = await import("./route");

    const res = await POST(pedido({ url: "https://revenda.example/feed.json", dry_run: false }));

    expect(res.status).toBe(200);
    const upsert = estado.escritas.find((e) => e.tipo === "upsert");
    expect(upsert?.tabela).toBe("catalog_feed_sources");
    expect(upsert?.valor).toMatchObject({ organization_id: ORG_ID, url: "https://revenda.example/feed.json" });
  });

  it("baixa as fotos do feed e grava CAMINHO, não URL", async () => {
    const { POST } = await import("./route");

    await POST(
      pedido({
        dry_run: false,
        itens: [{ id: "SKU-3", nome: "Película", preco: 19.9, fotos: "https://cdn.example/a.jpg|https://cdn.example/b.jpg" }],
      }),
    );

    const insert = estado.escritas.find((e) => e.tipo === "insert");
    const fotos = (insert?.valor as { fotos?: string[] }).fotos ?? [];
    expect(fotos).toHaveLength(2);
    expect(fotos.every((caminho) => caminho.startsWith(`${ORG_ID}/`))).toBe(true);
    expect(fotos.some((caminho) => caminho.startsWith("http"))).toBe(false);
  });
});

describe("POST /api/v1/products/feed — autoridade e escopo", () => {
  it("sem papel `manager` responde 403 e não escreve", async () => {
    const negado = new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 });
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: negado,
    } as never);
    const { POST } = await import("./route");

    const res = await POST(pedido({ itens: ITENS, dry_run: false }));

    expect(res.status).toBe(403);
    expect(estado.escritas).toEqual([]);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("a organização vem do COOKIE — o `organization_id` do corpo é ignorado", async () => {
    const { POST } = await import("./route");

    await POST(
      pedido({
        dry_run: false,
        organization_id: "99999999-9999-4999-8999-999999999999",
        itens: [{ id: "SKU-4", nome: "Suporte", preco: 49 }],
      }),
    );

    const escopos = estado.equais.filter(([coluna]) => coluna === "organization_id").map(([, valor]) => valor);
    expect(escopos.length).toBeGreaterThan(0);
    expect(new Set(escopos)).toEqual(new Set([ORG_ID]));
    const insert = estado.escritas.find((e) => e.tipo === "insert");
    expect((insert?.valor as { organization_id?: string }).organization_id).toBe(ORG_ID);
  });
});
