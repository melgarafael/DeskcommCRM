import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ escrita: vi.fn(), ligada: true, gravar: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: h.escrita,
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligada }));
vi.mock("@/lib/instalacao/config", () => ({ gravarPelaTela: h.gravar }));
vi.mock("@/lib/cobranca/configuracao", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cobranca/configuracao")>()),
  toleranciaDias: async () => 7,
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));

import { EscritaDePlatformAdminNegada } from "@/lib/auth/requirePlatformAdmin";

import { PATCH } from "./route";

const salvar = (corpo: unknown) =>
  PATCH(new NextRequest("http://localhost/api/v1/admin/cobranca/regua", { method: "PATCH", body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.escrita.mockResolvedValue({ user: { id: "dono" }, platformAdmin: { scope: "full" } });
  h.gravar.mockResolvedValue({ ok: true });
});

describe("régua da cobrança", () => {
  it("⭐ grava a tolerância e audita de quanto para quanto", async () => {
    const res = await salvar({ tolerancia_dias: 10 });
    expect((await res.json()).data).toEqual({ tolerancia_dias: 10 });
    expect(h.gravar).toHaveBeenCalledWith("COBRANCA_TOLERANCIA_DIAS", "10", { ehSegredo: false, ator: "dono" });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.regua_salva", metadata: { de: 7, para: 10 } }));
  });

  it.each([4, 31, 7.5, "7"])("%j fora de 5 a 30 dias inteiros: 422, nada gravado", async (valor) => {
    expect((await salvar({ tolerancia_dias: valor })).status).toBe(422);
    expect(h.gravar).not.toHaveBeenCalled();
  });

  it("chave desligada: 404", async () => {
    h.ligada = false;
    expect((await salvar({ tolerancia_dias: 10 })).status).toBe(404);
  });

  it("acesso só de leitura: 403", async () => {
    h.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("forbidden_scope", "somente leitura"));
    expect((await salvar({ tolerancia_dias: 10 })).status).toBe(403);
    expect(h.gravar).not.toHaveBeenCalled();
  });
});
