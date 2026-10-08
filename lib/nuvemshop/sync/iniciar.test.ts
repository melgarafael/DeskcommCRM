import { describe, expect, it, vi } from "vitest";
import type { DepsDoSync } from "./deps";
import { iniciarSincronizacao } from "./iniciar";

const AGORA = new Date("2026-10-08T12:00:00.000Z");

function deps(over: Partial<DepsDoSync> = {}): DepsDoSync {
  return {
    lerEstado: vi.fn().mockResolvedValue(null),
    carregarIntegracao: vi.fn().mockResolvedValue({ id: "integ-1", organizationId: "org-1", status: "healthy", storeId: "s1", accessToken: "t" }),
    api: vi.fn(),
    gravarPedido: vi.fn(),
    reservarRun: vi.fn().mockResolvedValue(true),
    registrarPagina: vi.fn(),
    fecharRun: vi.fn(),
    liberarRun: vi.fn(),
    emitirPasso: vi.fn().mockResolvedValue(undefined),
    desautorizar: vi.fn(),
    auditar: vi.fn(),
    novoRunId: () => "00000000-0000-4000-8000-0000000000aa",
    agora: () => AGORA,
    ...over,
  };
}

describe("iniciarSincronizacao", () => {
  it("sem cursor: reserva e emite a 1ª janela do backfill", async () => {
    const d = deps();
    await expect(iniciarSincronizacao(d, "org-1", "conexao")).resolves.toEqual({ ok: true, runId: "00000000-0000-4000-8000-0000000000aa" });
    expect(d.reservarRun).toHaveBeenCalledWith("org-1", expect.objectContaining({ origem: "conexao", forcar: true }));
    expect(d.emitirPasso).toHaveBeenCalledWith("org-1", "integ-1", expect.objectContaining({ janela_ini: "2025-10-08T12:00:00.000Z", pagina: 1 }));
  });

  it("reconciliação usa o cursor e não força", async () => {
    const d = deps({ lerEstado: vi.fn().mockResolvedValue({ cursor_updated_at: "2026-10-08T11:00:00.000Z" }) });
    await iniciarSincronizacao(d, "org-1", "reconciliacao");
    expect(d.reservarRun).toHaveBeenCalledWith("org-1", expect.objectContaining({ forcar: false }));
    expect(d.emitirPasso).toHaveBeenCalledWith("org-1", "integ-1", expect.objectContaining({ janela_ini: "2026-10-08T11:00:00.000Z" }));
  });

  it("sem integração ou desconectada → nao_conectada", async () => {
    await expect(iniciarSincronizacao(deps({ carregarIntegracao: vi.fn().mockResolvedValue(null) }), "org-1", "manual"))
      .resolves.toEqual({ ok: false, motivo: "nao_conectada" });
    await expect(iniciarSincronizacao(deps({ carregarIntegracao: vi.fn().mockResolvedValue({ id: "i", organizationId: "org-1", status: "disconnected", storeId: "s", accessToken: "t" }) }), "org-1", "manual"))
      .resolves.toEqual({ ok: false, motivo: "nao_conectada" });
  });

  it("integração em erro só recomeça pela conexão", async () => {
    const erro = vi.fn().mockResolvedValue({ id: "i", organizationId: "org-1", status: "error", storeId: "s", accessToken: "t" });
    await expect(iniciarSincronizacao(deps({ carregarIntegracao: erro }), "org-1", "manual")).resolves.toEqual({ ok: false, motivo: "desautorizada" });
  });

  it("integração em erro com origem conexao prossegue", async () => {
    const erro = vi.fn().mockResolvedValue({ id: "i", organizationId: "org-1", status: "error", storeId: "s", accessToken: "t" });
    await expect(iniciarSincronizacao(deps({ carregarIntegracao: erro }), "org-1", "conexao")).resolves.toMatchObject({ ok: true });
  });

  it("run ativo → sync_em_andamento, nada emitido", async () => {
    const d = deps({ reservarRun: vi.fn().mockResolvedValue(false) });
    await expect(iniciarSincronizacao(d, "org-1", "manual")).resolves.toEqual({ ok: false, motivo: "sync_em_andamento" });
    expect(d.emitirPasso).not.toHaveBeenCalled();
  });

  it("emissão falhou → libera o run e devolve falha_ao_iniciar", async () => {
    const d = deps({ emitirPasso: vi.fn().mockRejectedValue(new Error("rpc")) });
    await expect(iniciarSincronizacao(d, "org-1", "manual")).resolves.toEqual({ ok: false, motivo: "falha_ao_iniciar" });
    expect(d.liberarRun).toHaveBeenCalledWith("org-1", "00000000-0000-4000-8000-0000000000aa");
  });
});
