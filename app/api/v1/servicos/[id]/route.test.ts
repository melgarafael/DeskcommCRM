import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { detalheDoItem, lerFamilias, salvarServico } from "@/lib/catalogo/servicos-supabase";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/catalogo/servicos-supabase", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  detalheDoItem: vi.fn(),
  lerFamilias: vi.fn(async () => []),
  salvarServico: vi.fn(),
}));

import { GET, PATCH } from "./route";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const VARIACAO_ID = "44444444-4444-4444-8444-444444444444";

const DETALHE_PRINCIPAL = {
  product_id: PRINCIPAL_ID,
  pai_product_id: null,
  tipo: "recorrente",
  unidade: "mes",
  prazo_dias_uteis: null,
  sinal_tipo: "percentual",
  sinal_percentual: 30,
  sinal_cents: null,
  instrucoes_ia: null,
  ia_oferece: true,
  revision: 3,
};
const DETALHE_VARIACAO = {
  ...DETALHE_PRINCIPAL,
  product_id: VARIACAO_ID,
  pai_product_id: PRINCIPAL_ID,
  tipo: null,
  unidade: null,
  sinal_tipo: null,
  sinal_percentual: null,
  revision: 1,
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, corpo: unknown) =>
  PATCH(
    new NextRequest(`http://localhost/api/v1/servicos/${id}`, { method: "PATCH", body: JSON.stringify(corpo) }),
    ctx(id),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moduloLigado).mockResolvedValue(true);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u", idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(detalheDoItem).mockImplementation(async (_db, _org, id) =>
    id === PRINCIPAL_ID ? DETALHE_PRINCIPAL : id === VARIACAO_ID ? DETALHE_VARIACAO : null,
  );
});

describe("módulo desligado", () => {
  it("GET e PATCH respondem 404 e não alcançam o banco do módulo", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    expect((await GET(new NextRequest("http://localhost"), ctx(PRINCIPAL_ID))).status).toBe(404);
    expect((await patch(PRINCIPAL_ID, { nome: "x", expected_revision: 3 })).status).toBe(404);
    expect(createClient).not.toHaveBeenCalled();
    expect(detalheDoItem).not.toHaveBeenCalled();
    expect(salvarServico).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/servicos/[id]", () => {
  it("revisão velha = 409 com a revisão atual, nunca 'salvou por cima'", async () => {
    vi.mocked(salvarServico).mockResolvedValue({ ok: false, motivo: "revisao_velha", detalhe: "4" });
    const r = await patch(PRINCIPAL_ID, { nome: "Novo", expected_revision: 3 });
    expect(r.status).toBe(409);
    expect((await r.json()).error.details).toEqual({ revision_atual: 4 });
  });

  it("sinal fixo acima do menor preço da família = 422 no campo sinal (a regra é do banco, com a família travada)", async () => {
    vi.mocked(salvarServico).mockResolvedValue({
      ok: false,
      motivo: "regra",
      detalhe: "servico_sinal_acima_do_preco",
    });
    const r = await patch(PRINCIPAL_ID, { sinal: { tipo: "fixo", valor: 999_999 }, expected_revision: 3 });
    expect(r.status).toBe(422);
    expect((await r.json()).error.details.sinal).toEqual([
      "o sinal fixo não pode passar do preço da menor variação",
    ]);
  });

  it("a régua roda sobre a linha mesclada: unidade nova contra o tipo gravado", async () => {
    const r = await patch(PRINCIPAL_ID, { unidade: "hora", expected_revision: 3 });
    expect(r.status).toBe(422);
    expect(salvarServico).not.toHaveBeenCalled();
  });

  it("variação não recebe detalhe do principal; só ia_oferece é dela", async () => {
    expect((await patch(VARIACAO_ID, { sinal: { tipo: "fixo", valor: 10 }, expected_revision: 1 })).status).toBe(422);
    expect(salvarServico).not.toHaveBeenCalled();

    vi.mocked(salvarServico).mockResolvedValue({ ok: true, productId: VARIACAO_ID, principalId: PRINCIPAL_ID, revision: 2 });
    expect((await patch(VARIACAO_ID, { preco_cents: 5_000, ia_oferece: false, expected_revision: 1 })).status).toBe(200);
    expect(vi.mocked(salvarServico).mock.calls[0]![3]).toEqual({
      item: { preco_cents: 5_000 },
      detalhe: { ia_oferece: false },
      expectedRevision: 1,
    });
  });

  it("produto que não é serviço = 404", async () => {
    expect((await patch("55555555-5555-4555-8555-555555555555", { nome: "Nome válido", expected_revision: 1 })).status).toBe(404);
  });
});

describe("GET /api/v1/servicos/[id]", () => {
  it("lê a família pelo principal, mesmo quando o id é da variação", async () => {
    await GET(new NextRequest("http://localhost"), ctx(VARIACAO_ID));
    expect(vi.mocked(lerFamilias).mock.calls[0]![2]).toEqual([PRINCIPAL_ID]);
  });
});
