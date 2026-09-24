/**
 * Os roteiros de atendimento (#1130) chegam em partes: até a tela existir
 * (PR 3), ligar o módulo poria o motor no turno sem que ninguém visse o que ele
 * coleta. A ação RECUSA ligar `fluxos_atendimento`; desligar segue permitido, e
 * o banco externo liga como sempre.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ upsert: vi.fn(), audit: vi.fn() }));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: async () => ({ user: { id: "eu" } }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ in: async () => ({ data: [], error: null }) }),
      upsert: deps.upsert,
    }),
  }),
}));

import { updateModuloDaInstalacao } from "./updateModuloDaInstalacao";

beforeEach(() => {
  vi.clearAllMocks();
  deps.upsert.mockResolvedValue({ error: null });
});

describe("updateModuloDaInstalacao", () => {
  it("recusa LIGAR os roteiros de atendimento antes da tela", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "fluxos_atendimento", ligado: true })).toEqual({
      ok: false,
      error: "modulo_ainda_nao_disponivel",
    });
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("desligar os roteiros continua permitido", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "fluxos_atendimento", ligado: false })).toEqual({ ok: true });
  });

  it("o banco externo liga como sempre", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "banco_externo", ligado: true })).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledTimes(1);
  });
});
