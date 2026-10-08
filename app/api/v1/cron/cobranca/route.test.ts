import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ autorizado: true, ligada: true, rodada: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => h.autorizado }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligada }));
vi.mock("@/lib/cobranca/rodada", () => ({ rodadaDaCobranca: h.rodada }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { GET } from "./route";

const VAZIA = { relidas: 0, falhas: 0, avisos: 0, suspensas: 0, reativadas: 0, canceladas: 0, avisosDeIa: 0 };
const chamar = () => GET(new NextRequest("http://localhost/api/v1/cron/cobranca"));

beforeEach(() => {
  vi.clearAllMocks();
  h.autorizado = true;
  h.ligada = true;
  h.rodada.mockResolvedValue(VAZIA);
});

describe("cron da cobrança", () => {
  it("sem o segredo do cron: 403 (o molde das rotas de cron) e nada roda", async () => {
    h.autorizado = false;
    expect((await chamar()).status).toBe(403);
    expect(h.rodada).not.toHaveBeenCalled();
  });

  it("chave desligada: sai sem rodar e sem auditar", async () => {
    h.ligada = false;
    const res = await chamar();
    expect((await res.json()).data).toEqual({ pulado: "modulo_desligado" });
    expect(h.rodada).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ rodada com efeito: uma linha cobranca.rodada com as contagens", async () => {
    h.rodada.mockResolvedValue({ ...VAZIA, relidas: 3, suspensas: 1 });
    await chamar();
    expect(h.audit).toHaveBeenCalledOnce();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.rodada", metadata: { ...VAZIA, relidas: 3, suspensas: 1 } }));
  });

  it("rodada vazia (ou só com leituras que falharam) não audita", async () => {
    await chamar();
    h.rodada.mockResolvedValue({ ...VAZIA, falhas: 2 });
    await chamar();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
