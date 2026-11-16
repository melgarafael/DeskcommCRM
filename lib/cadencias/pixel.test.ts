import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/v1/webhooks/cadencia-pixel/[token]/route";
const m = vi.hoisted(() => ({ ligado: vi.fn(), verificar: vi.fn(), rpc: vi.fn(), eq: vi.fn(), consentimento: false, limite: vi.fn(), falha: vi.fn() }));
vi.mock("@/lib/cadencias/modulo", () => ({ cadenciasLigadas: m.ligado }));
vi.mock("@/lib/cadencias/token", () => ({ verifyCadenciaLink: m.verificar }));
vi.mock("@/lib/auth/rate-limit", () => ({ tokenFailureLimited: m.limite, registrarFalhaDeToken: m.falha }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => {
  const q = { select: () => q, eq: (campo: string, valor: string) => { m.eq(campo, valor); return q; }, maybeSingle: async () => ({ data: { id: "inscricao", rastreio_consentido: m.consentimento }, error: null }) };
  return { from: () => q, rpc: m.rpc };
} }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
const payload = { enrollment_id: "inscricao", organization_id: "empresa", cadence_id: "cadencia", lead_id: "negocio", passo_id: "email-1" };
const abrir = () => GET({} as NextRequest, { params: Promise.resolve({ token: "token-sintetico" }) });
beforeEach(() => { vi.clearAllMocks(); m.ligado.mockResolvedValue(true); m.verificar.mockReturnValue(payload); m.rpc.mockResolvedValue({ error: null }); m.limite.mockResolvedValue(false); m.consentimento = false; });
describe("pixel só produz efeito com consentimento e módulo atuais", () => {
  it("sem autorização devolve imagem sem registrar abertura", async () => {
    const res = await abrir(); expect(res.headers.get("content-type")).toBe("image/gif"); expect(m.rpc).not.toHaveBeenCalled();
    expect(m.eq).toHaveBeenCalledWith("organization_id", "empresa");
  });
  it("desligado não consulta a inscrição nem chama RPC", async () => {
    m.ligado.mockResolvedValue(false); await abrir(); expect(m.eq).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("com autorização passa organização e passo assinados para a RPC atômica", async () => {
    m.consentimento = true; await abrir(); expect(m.verificar).toHaveBeenCalledWith("token-sintetico", "abertura");
    expect(m.rpc).toHaveBeenCalledWith("fn_cadencia_registrar_abertura", { p_enrollment_id: "inscricao", p_organization_id: "empresa", p_passo_id: "email-1" });
  });
  it("token inválido debita o limite canônico, sem efeito de negócio", async () => {
    m.verificar.mockReturnValue(null); await abrir(); expect(m.falha).toHaveBeenCalledWith("token-sintetico"); expect(m.rpc).not.toHaveBeenCalled();
  });
});
