// @vitest-environment node
//
// O `NextRequest.json()` do route handler precisa do realm do Node — o mesmo
// motivo documentado em `app/api/v1/products/import/route.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { ProdutoExistente } from "@/lib/catalogo/feed";
import { guardarFotosPorUrl } from "@/lib/catalogo/fotos-por-url";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: vi.fn(async () => "BRL") }));
vi.mock("@/lib/catalogo/fotos-por-url", () => ({ guardarFotosPorUrl: vi.fn() }));
vi.mock("@/lib/catalogo/fotos-no-bucket", () => ({ apagarDoBucket: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Contador de ESCRITAS — é o que prova o dry-run. */
let escritas: { insert: number; update: number; delete: number; upsert: number };
/** O "banco" desta rodada: o DELETE aplicado aqui faria a linha sumir. */
let banco: Array<ProdutoExistente & { organization_id?: string }>;
/** Os patches de UPDATE, na ordem, para conferir o que foi escrito. */
let patches: Array<{ patch: Record<string, unknown>; id: string | null }>;

function clienteFalso() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            range: async (de: number, ate: number) => ({
              data: banco.slice(de, ate + 1).map((r) => ({ ...r })),
              error: null,
            }),
          }),
        }),
      }),
      insert: (linha: Record<string, unknown>) => {
        escritas.insert += 1;
        banco.push(linha as unknown as ProdutoExistente);
        return Promise.resolve({ error: null });
      },
      upsert: () => {
        escritas.upsert += 1;
        return Promise.resolve({ error: null });
      },
      update: (patch: Record<string, unknown>) => {
        escritas.update += 1;
        return {
          eq: (_coluna: string, _valor: string) => ({
            eq: async (_coluna2: string, id: string) => {
              const alvo = banco.find((r) => r.id === id);
              if (alvo) Object.assign(alvo, patch);
              patches.push({ patch, id });
              return { error: null };
            },
          }),
        };
      },
      delete: () => {
        escritas.delete += 1;
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
}

function existente(over: Partial<ProdutoExistente> & { codigo: string }): ProdutoExistente {
  return {
    id: `id-${over.codigo}`,
    nome: `Produto ${over.codigo}`,
    descricao: null,
    preco_cents: 1000,
    marca: null,
    categoria: null,
    quantidade: null,
    fotos: null,
    ativo: true,
    origem: "feed",
    ...over,
  };
}

const MAPEAMENTO = { id_externo: "sku", nome: "titulo", preco: "preco" };

function pedido(corpo: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/v1/products/feed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mapeamento: MAPEAMENTO, ...corpo }),
  });
}

const FEED = [
  { sku: "A", titulo: "Produto A", preco: 12.5 },
  { sku: "C", titulo: "Produto C", preco: 30 },
];

beforeEach(() => {
  vi.clearAllMocks();
  escritas = { insert: 0, update: 0, delete: 0, upsert: 0 };
  patches = [];
  banco = [existente({ codigo: "A" }), existente({ codigo: "B" })];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue(clienteFalso() as never);
  vi.mocked(guardarFotosPorUrl).mockResolvedValue({ ok: true, caminhos: ["org/x/1.jpg"] });
});

describe("POST /api/v1/products/feed — dry-run", () => {
  it("devolve o plano e NÃO emite INSERT/UPDATE/DELETE", async () => {
    const { POST } = await import("./route");
    const resposta = await POST(pedido({ itens: FEED, dry_run: true }));
    const corpo = await resposta.json();

    expect(resposta.status).toBe(200);
    expect(corpo.data.aplicado).toBe(false);
    expect(corpo.data.contagem).toEqual({ criar: 1, atualizar: 1, desativar: 1, inalterados: 0 });
    expect(escritas).toEqual({ insert: 0, update: 0, delete: 0, upsert: 0 });
    expect(guardarFotosPorUrl).not.toHaveBeenCalled();
  });

  it("é o default: sem `dry_run` no corpo, nada é escrito", async () => {
    const { POST } = await import("./route");
    const resposta = await POST(pedido({ itens: FEED }));
    const corpo = await resposta.json();

    expect(corpo.data.aplicado).toBe(false);
    expect(escritas.insert + escritas.update + escritas.delete).toBe(0);
  });
});

describe("POST /api/v1/products/feed — aplicação", () => {
  it("cria o novo, atualiza o que mudou e DESATIVA o que saiu — sem DELETE", async () => {
    const { POST } = await import("./route");
    const resposta = await POST(pedido({ itens: FEED, dry_run: false }));
    const corpo = await resposta.json();

    expect(resposta.status).toBe(200);
    expect(corpo.data.aplicado).toBe(true);
    expect(escritas.insert).toBe(1);
    // Um preço + uma desativação: duas linhas, dois UPDATEs.
    expect(escritas.update).toBe(2);
    expect(escritas.delete).toBe(0);

    // A linha desativada CONTINUA no banco — só muda `ativo`.
    expect(banco).toHaveLength(3);
    const b = banco.find((r) => r.codigo === "B")!;
    expect(b.ativo).toBe(false);
    expect(patches.find((p) => p.id === "id-B")?.patch).toEqual({ ativo: false });

    // A atualização de preço é o único campo que mudou.
    const a = banco.find((r) => r.codigo === "A")!;
    expect(a.preco_cents).toBe(1250);
    expect(patches.find((p) => p.id === "id-A")?.patch).toEqual({ origem: "feed", preco_cents: 1250 });
  });

  it("rodar o MESMO feed de novo não escreve nada", async () => {
    const { POST } = await import("./route");
    await POST(pedido({ itens: FEED, dry_run: false }));
    escritas = { insert: 0, update: 0, delete: 0, upsert: 0 };

    // O "banco" já está no estado pós-primeira-rodada (A com 1250, C criado,
    // B desativado pelo UPDATE acima).
    const segunda = await POST(pedido({ itens: FEED, dry_run: false }));
    const corpo = await segunda.json();

    expect(corpo.data.contagem).toEqual({ criar: 0, atualizar: 0, desativar: 0, inalterados: 2 });
    expect(escritas).toEqual({ insert: 0, update: 0, delete: 0, upsert: 0 });
  });

  it("id externo repetido no feed grava UMA linha e reporta o outro item em `erros`", async () => {
    const { POST } = await import("./route");
    const resposta = await POST(
      pedido({
        itens: [
          { sku: "D", titulo: "Duplicado", preco: 10 },
          { sku: "D", titulo: "Duplicado de novo", preco: 20 },
        ],
        dry_run: false,
      }),
    );
    const corpo = await resposta.json();

    expect(escritas.insert).toBe(1);
    expect(banco.filter((r) => r.codigo === "D")).toHaveLength(1);
    expect(corpo.data.erros).toHaveLength(1);
    expect(corpo.data.erros[0].linha).toBe(2);
    expect(corpo.data.erros[0].motivo).toContain("repetido");
  });

  it("a organização vem do cookie: `organization_id` no corpo é ignorado", async () => {
    const { POST } = await import("./route");
    await POST(
      pedido({
        itens: FEED,
        dry_run: false,
        organization_id: "99999999-9999-4999-8999-999999999999",
      }),
    );

    const inserido = banco.find((r) => r.codigo === "C")!;
    expect(inserido.organization_id).toBe(ORG_ID);
    // Nenhum UPDATE pode ter ido para outra organização: o fake só casa pelo
    // `id`, então a prova é o payload de insert acima mais o `orgId` usado nas
    // leituras (o fake devolve o banco desta org e o plano saiu dele).
    expect(banco.every((r) => r.organization_id === undefined || r.organization_id === ORG_ID)).toBe(true);
  });
});

describe("POST /api/v1/products/feed — autorização e formato", () => {
  it("sem papel `manager` responde 403 e não toca no banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "papel insuficiente", 403),
    } as never);

    const { POST } = await import("./route");
    const resposta = await POST(pedido({ itens: FEED, dry_run: false }));

    expect(resposta.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
    expect(escritas).toEqual({ insert: 0, update: 0, delete: 0, upsert: 0 });
  });

  it("duas fontes no corpo é 422 — não escolhe uma por conta própria", async () => {
    const { POST } = await import("./route");
    const resposta = await POST(pedido({ itens: FEED, url: "https://loja.example/feed.json" }));

    expect(resposta.status).toBe(422);
  });

  it("item sem id externo não aborta: o outro entra", async () => {
    const { POST } = await import("./route");
    const resposta = await POST(
      pedido({
        itens: [{ sku: "", titulo: "Sem id", preco: 10 }, { sku: "E", titulo: "Com id", preco: 10 }],
        dry_run: false,
      }),
    );
    const corpo = await resposta.json();

    expect(escritas.insert).toBe(1);
    expect(banco.some((r) => r.codigo === "E")).toBe(true);
    expect(corpo.data.erros).toHaveLength(1);
  });
});
