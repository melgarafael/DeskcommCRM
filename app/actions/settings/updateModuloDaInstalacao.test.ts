/**
 * Os roteiros de atendimento (#1130) chegaram em partes, e o PR 2 recusava
 * ligar o módulo até a tela existir. Com as telas (PR 3), quem administra o
 * servidor liga e desliga os dois módulos opcionais aqui.
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
  it("com as telas, os roteiros de atendimento LIGAM", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "fluxos_atendimento", ligado: true })).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ chave: "MODULO_FLUXOS_DE_ATENDIMENTO", valor: "ligado" }),
      expect.anything(),
    );
  });

  it("desligar os roteiros continua permitido", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "fluxos_atendimento", ligado: false })).toEqual({ ok: true });
  });

  it("o banco externo liga como sempre", async () => {
    expect(await updateModuloDaInstalacao({ modulo: "banco_externo", ligado: true })).toEqual({ ok: true });
    expect(deps.upsert).toHaveBeenCalledTimes(1);
  });
});
