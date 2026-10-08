import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, type BancoFalso, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  escrita: vi.fn(),
  audit: vi.fn(),
  ligada: true,
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false, loadAuthUser: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: h.escrita,
}));
vi.mock("@/lib/instalacao/modulos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instalacao/modulos")>()),
  moduloLigado: async (_db: unknown, modulo: string) => modulo === "cobranca" && h.ligada,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

import { EscritaDePlatformAdminNegada } from "@/lib/auth/requirePlatformAdmin";

import { POST } from "./route";

const CORPO = { nome: "Básico", preco_cents: 4990, intervalo: "mes", trial_dias: 14, max_assentos: 3, max_canais: 1, padrao_no_cadastro: true };
const PLANO = { id: "cccccccc-0000-4000-8000-000000000001", ...CORPO, moeda: "BRL", teto_ia_usd_cents: null, arquivado_em: null };
const pedido = (body: unknown) =>
  new NextRequest("http://localhost/api/v1/admin/cobranca/planos", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });

let resposta: Resposta;
beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.escrita.mockResolvedValue({ user: { id: h.ator }, platformAdmin: { user_id: h.ator, scope: "full", mfa_required: false } });
  resposta = { data: PLANO };
  h.banco = bancoFalso(() => resposta);
});

describe("POST /api/v1/admin/cobranca/planos", () => {
  it("cria o plano com quem criou e audita cobranca.plano_salvo", async () => {
    const res = await POST(pedido(CORPO));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual(PLANO);
    expect(h.banco.cadeias).toHaveLength(1);
    const [insercao] = h.banco.cadeias;
    expect(insercao!.tabela).toBe("cobranca_planos");
    expect(argumentos(insercao!, "insert")?.[0]).toEqual({ ...CORPO, updated_by: h.ator });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cobranca.plano_salvo", actorUserId: h.ator, resourceId: PLANO.id }),
    );
  });

  it("chave desligada → 404, e o banco nem é tocado", async () => {
    h.ligada = false;
    expect((await POST(pedido(CORPO))).status).toBe(404);
    expect(h.banco.cadeias).toEqual([]);
  });

  it("support_readonly → 403 forbidden_scope, nada gravado", async () => {
    h.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("forbidden_scope", "somente leitura"));
    const res = await POST(pedido(CORPO));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.banco.cadeias).toEqual([]);
  });

  it.each([
    ["preço abaixo de R$ 5", { ...CORPO, preco_cents: 499 }],
    ["teste grátis acima de 90 dias", { ...CORPO, trial_dias: 91 }],
    ["intervalo fora do vocabulário", { ...CORPO, intervalo: "semana" }],
    ["teto de IA abaixo de US$ 1", { ...CORPO, teto_ia_usd_cents: 99 }],
    ["moeda (só BRL, fixada no banco)", { ...CORPO, moeda: "USD" }],
    ["nome em branco", { ...CORPO, nome: "  " }],
  ])("%s → 400, nada gravado", async (_caso, corpo) => {
    expect((await POST(pedido(corpo))).status).toBe(400);
    expect(h.banco.cadeias).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("segundo plano do cadastro (índice cobranca_planos_um_padrao) → 409 state_conflict", async () => {
    resposta = { error: { code: "23505", message: "duplicate key" } };
    const res = await POST(pedido(CORPO));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("state_conflict");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("erro do banco → 500 sem audit", async () => {
    resposta = { error: { code: "XX000", message: "boom" } };
    expect((await POST(pedido(CORPO))).status).toBe(500);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
