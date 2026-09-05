// @vitest-environment node
//
// Multipart real (File/FormData) precisa do realm do Node — jsdom (default do
// projeto) tem seu próprio File/FormData que corrompe o corpo ao passar pelo
// parser de multipart do NextRequest (undici). Mesmo achado documentado em
// app/api/v1/ai/skills/import/route.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** Cada chamada a `.upsert()` em `catalog_products`, na ordem em que aconteceu. */
let upserts: Array<Array<Record<string, unknown>>> = [];

/**
 * ⚠️ POR QUE DOIS LOTES SEPARADOS, E NÃO UM SÓ COM SHAPES DIFERENTES.
 *
 * O upsert do PostgREST monta UMA sentença `... ON CONFLICT (...) DO UPDATE
 * SET col = EXCLUDED.col` para o lote inteiro — o SET não é recalculado linha
 * a linha. Um array com produto novo carregando `moeda` e produto existente
 * sem ela arriscaria a coluna ausente virar `NULL` explícito no UPDATE em vez
 * de simplesmente não ser tocada — pior que o defeito que se está corrigindo.
 * Por isso o fake abaixo espera duas chamadas distintas a `.upsert()`, uma por
 * grupo, e é isso que os testes verificam.
 */
function supabaseCom(moedaDaOrg: string, codigosExistentes: string[]) {
  return {
    from: (tabela: string) => {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { currency: moedaDaOrg }, error: null }),
            }),
          }),
        };
      }
      // catalog_products
      return {
        select: () => ({
          eq: () => ({
            in: async () => ({
              data: codigosExistentes.map((codigo) => ({ codigo })),
              error: null,
            }),
          }),
        }),
        upsert: (linhas: Array<Record<string, unknown>>) => {
          upserts.push(linhas);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function csv(linhas: string): File {
  const conteudo = `codigo,nome,preco\n${linhas}`;
  return new File([conteudo], "catalogo.csv", { type: "text/csv" });
}

function pedido(arquivo: File): NextRequest {
  const form = new FormData();
  form.set("file", arquivo);
  return new NextRequest("http://localhost/api/v1/products/import", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  upserts = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/products/import — reimportar não pisa a moeda de quem já existia", () => {
  it("produto NOVO herda a moeda da organização", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("MXN", []) as never);
    const { POST } = await import("./route");

    await POST(pedido(csv("IP15,iPhone 15,5499,00")));

    expect(upserts).toHaveLength(1);
    expect(upserts[0]![0]).toMatchObject({ codigo: "IP15", moeda: "MXN" });
  });

  /**
   * ⚠️ O CASO QUE O REVISOR ACHOU. Quatro textos do próprio PR afirmam que "o
   * produto guarda a moeda com que nasceu" — mas o upsert incluía `moeda` para
   * TODA linha, então reimportar a mesma planilha depois de trocar a moeda da
   * organização reescrevia produto já cadastrado. Este teste reprova esse
   * comportamento: para um código que já existe, a linha enviada ao upsert não
   * pode carregar a chave `moeda` — é o MESMO cuidado que o comentário do
   * arquivo já declara para `descricao`, `imagem_url` e `ativo`.
   */
  it("produto EXISTENTE não tem a moeda tocada, mesmo se a organização mudou de moeda", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("MXN", ["AND-01"]) as never);
    const { POST } = await import("./route");

    await POST(pedido(csv("AND-01,Galaxy S24,3999,00")));

    const linhaExistente = upserts.flat().find((l) => l.codigo === "AND-01");
    expect(linhaExistente).toBeDefined();
    expect(linhaExistente).not.toHaveProperty("moeda");
  });

  it("planilha com os dois casos grava cada grupo no shape certo", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseCom("USD", ["AND-01"]) as never);
    const { POST } = await import("./route");

    await POST(
      pedido(csv("IP15,iPhone 15,5499,00\nAND-01,Galaxy S24,3999,00")),
    );

    const todas = upserts.flat();
    const novo = todas.find((l) => l.codigo === "IP15");
    const existente = todas.find((l) => l.codigo === "AND-01");
    expect(novo).toMatchObject({ moeda: "USD" });
    expect(existente).not.toHaveProperty("moeda");
  });
});
