import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao, type BancoFalso } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  papel: vi.fn(),
  linha: null as Record<string, unknown> | null,
  cancelar: vi.fn(),
  sincronizar: vi.fn(),
  audit: vi.fn(),
  taxaOk: true,
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.papel }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: h.taxaOk }) }));
vi.mock("@/lib/cobranca/provedores", () => ({ adaptador: () => ({ cancelarNoFim: h.cancelar }) }));
vi.mock("@/lib/cobranca/sincronizar", () => ({ sincronizar: h.sincronizar }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";

import { POST } from "./route";

const ORG = "14141414-0000-4000-8000-000000000001";
const PAGA = { provedor: "stripe", provedor_assinatura_id: "sub_1", proximo_vencimento: "2026-11-01T00:00:00.000Z", cancela_no_fim: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.linha = { ...PAGA };
  h.taxaOk = true;
  h.banco = bancoFalso(() => ({ data: h.linha }));
  h.papel.mockResolvedValue({ ok: true, user: { id: "admin-1" }, org: { orgId: ORG } });
  h.cancelar.mockResolvedValue(undefined);
  h.sincronizar.mockResolvedValue({ tipo: "aplicada", estado: "ativa", mudou: false, acao: "nada" });
});

describe("cancelar a assinatura", () => {
  it("⭐ cancela no fim do período pago, relê e diz até quando o acesso vale (D-14)", async () => {
    expect((await (await POST()).json()).data).toEqual({ changed: true, acesso_ate: "2026-11-01T00:00:00.000Z" });
    expect(h.cancelar).toHaveBeenCalledWith("sub_1");
    expect(h.sincronizar).toHaveBeenCalledWith(h.banco.cliente, ORG);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.assinatura_cancelada", metadata: { motivo: "pedido_da_empresa" } }));
  });

  it("já está cancelando: 200 sem chamar o provedor de novo", async () => {
    h.linha = { ...PAGA, cancela_no_fim: true };
    expect((await (await POST()).json()).data).toEqual({ changed: false, acesso_ate: "2026-11-01T00:00:00.000Z" });
    expect(h.cancelar).not.toHaveBeenCalled();
  });

  it("sem assinatura paga (só teste grátis): 409", async () => {
    h.linha = { provedor: null, provedor_assinatura_id: null, proximo_vencimento: null, cancela_no_fim: false };
    expect((await POST()).status).toBe(409);
  });

  it("provedor fora do ar: 503 e nada auditado", async () => {
    h.cancelar.mockRejectedValue(new ErroDoProvedor(503, "api_error", true));
    expect((await POST()).status).toBe(503);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("acima de 10 por minuto da mesma empresa: 429 sem chamar o provedor", async () => {
    h.taxaOk = false;
    expect((await POST()).status).toBe(429);
    expect(h.cancelar).not.toHaveBeenCalled();
  });

  it("⭐ sincronizar que lança depois do cancelamento no provedor: o audit com o ator já saiu e a resposta é 200", async () => {
    h.sincronizar.mockRejectedValue(new Error("banco caiu"));
    const res = await POST();
    expect(res.status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.assinatura_cancelada", actorUserId: "admin-1" }));
  });

  it("⭐ a rota grava cancela_no_fim=true sem depender da releitura (que pode falhar)", async () => {
    h.sincronizar.mockResolvedValue({ tipo: "falhou", erro: "provedor_fora", transitorio: true });
    await POST();
    const escrita = h.banco.cadeias.find((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update");
    expect(argumentos(escrita!, "update")?.[0]).toMatchObject({ cancela_no_fim: true });
  });
});
