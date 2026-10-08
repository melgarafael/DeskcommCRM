import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  papel: vi.fn(),
  ligada: true,
  permitido: true,
  sincronizar: vi.fn(),
  linha: { estado: "ativa", assinaturas_vivas: 1 } as Record<string, unknown> | null,
  status: "active",
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.papel }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligada }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: h.permitido }) }));
vi.mock("@/lib/cobranca/sincronizar", () => ({ sincronizar: h.sincronizar }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));

import { POST } from "./route";

const ORG = "12121212-0000-4000-8000-000000000001";
const responder = (c: Cadeia): Resposta => (c.tabela === "organizations" ? { data: { status: h.status } } : { data: h.linha });

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.permitido = true;
  h.linha = { estado: "ativa", assinaturas_vivas: 1 };
  h.status = "active";
  h.banco = bancoFalso(responder);
  h.papel.mockResolvedValue({ ok: true, user: { id: "admin-1" }, org: { orgId: ORG } });
  h.sincronizar.mockResolvedValue({ tipo: "aplicada", estado: "ativa", mudou: true, acao: "reativar" });
});

describe("sincronizar pela tela", () => {
  it("⭐ relê no provedor e diz o estado e se a empresa voltou a operar", async () => {
    const res = await POST();
    expect((await res.json()).data).toEqual({ estado: "ativa", assinaturas_vivas: 1, org_operante: true });
    expect(h.sincronizar).toHaveBeenCalledWith(h.banco.cliente, ORG);
  });

  it("ainda devendo e suspensa: a tela recebe os dois fatos", async () => {
    h.linha = { estado: "em_atraso", assinaturas_vivas: 1 };
    h.status = "suspended";
    h.sincronizar.mockResolvedValue({ tipo: "aplicada", estado: "em_atraso", mudou: false, acao: "nada" });
    expect((await (await POST()).json()).data).toEqual({ estado: "em_atraso", assinaturas_vivas: 1, org_operante: false });
  });

  it("segundo clique dentro de 30 s: 429 com Retry-After, sem reler", async () => {
    h.permitido = false;
    const res = await POST();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(h.sincronizar).not.toHaveBeenCalled();
  });

  it("provedor fora do ar: 503 com frase para leigo", async () => {
    h.sincronizar.mockResolvedValue({ tipo: "falhou", erro: "provedor_fora", transitorio: true });
    expect((await POST()).status).toBe(503);
  });

  it("chave desligada, ou empresa isenta: 404", async () => {
    h.ligada = false;
    expect((await POST()).status).toBe(404);
    h.ligada = true;
    h.sincronizar.mockResolvedValue({ tipo: "isenta" });
    expect((await POST()).status).toBe(404);
  });

  it("⭐ falha que NÃO é transitória (chave inválida): 502 provedor_recusou mandando falar com quem administra, nunca 'tente de novo'", async () => {
    h.sincronizar.mockResolvedValue({ tipo: "falhou", erro: "credencial_invalida", transitorio: false });
    const res = await POST();
    expect(res.status).toBe(502);
    const e = (await res.json()).error as { code: string; message: string };
    expect(e.code).toBe("provedor_recusou");
    expect(e.message).toMatch(/administra/);
    expect(e.message).not.toMatch(/tente de novo/i);
  });
});
