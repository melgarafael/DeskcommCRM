import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { detalheDoItem, listarServicos, salvarServico } from "@/lib/catalogo/servicos-supabase";
import { moduloLigado } from "@/lib/instalacao/modulos";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: vi.fn(async () => "BRL") }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn(async () => true) }));
vi.mock("@/lib/catalogo/servicos-supabase", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  detalheDoItem: vi.fn(async () => null),
  lerFamilias: vi.fn(async () => []),
  listarServicos: vi.fn(async () => ({ linhas: [], principais: [], temMais: true })),
  salvarServico: vi.fn(),
}));

import { GET, POST } from "./route";

const PAI = "33333333-3333-4333-8333-333333333333";
const post = (corpo: unknown) =>
  POST(new NextRequest("http://localhost/api/v1/servicos", { method: "POST", body: JSON.stringify(corpo) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moduloLigado).mockResolvedValue(true);
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u", idioma: "pt-BR" }, org: { orgId: "org" } } as never);
});

describe("/api/v1/servicos", () => {
  it("módulo desligado: GET e POST são 404 e nada do módulo é lido ou gravado", async () => {
    vi.mocked(moduloLigado).mockResolvedValue(false);
    expect((await GET(new NextRequest("http://localhost/api/v1/servicos"))).status).toBe(404);
    expect((await post({ codigo: "C", nome: "Nome", preco_cents: 1, tipo: "projeto", unidade: "hora" })).status).toBe(404);
    expect(listarServicos).not.toHaveBeenCalled();
    expect(salvarServico).not.toHaveBeenCalled();
  });

  it("GET pagina por serviço e diz se há mais", async () => {
    const r = await GET(new NextRequest("http://localhost/api/v1/servicos?pagina=2"));
    expect(vi.mocked(listarServicos).mock.calls[0]![2]).toBe(2);
    expect((await r.json()).meta).toEqual({ pagina: 2, por_pagina: 50, has_more: true });
  });

  it("variação de quem já é variação = 422, sem gravar", async () => {
    vi.mocked(detalheDoItem).mockResolvedValue({
      product_id: PAI, pai_product_id: "44444444-4444-4444-8444-444444444444", tipo: null, unidade: null,
      prazo_dias_uteis: null, sinal_tipo: null, sinal_percentual: null, sinal_cents: null, instrucoes_ia: null,
      ia_oferece: true, revision: 1,
    });
    const r = await post({ codigo: "V", nome: "Variação", preco_cents: 1, pai_id: PAI });
    expect(r.status).toBe(422);
    expect(salvarServico).not.toHaveBeenCalled();
  });

  it("o principal vai ao banco com o detalhe; a recusa do sinal volta no campo sinal", async () => {
    vi.mocked(salvarServico).mockResolvedValue({ ok: false, motivo: "regra", detalhe: "servico_sinal_acima_do_preco" });
    const r = await post({
      codigo: "SITE", nome: "Site", preco_cents: 10_000, tipo: "projeto", unidade: "valor_fechado",
      prazo_dias_uteis: 15, sinal: { tipo: "fixo", valor: 20_000 },
    });
    expect(r.status).toBe(422);
    expect((await r.json()).error.details.sinal).toBeDefined();
    expect(vi.mocked(salvarServico).mock.calls[0]![3].detalhe).toMatchObject({
      tipo: "projeto", unidade: "valor_fechado", prazo_dias_uteis: 15, sinal_tipo: "fixo", sinal_cents: 20_000,
    });
  });
});
