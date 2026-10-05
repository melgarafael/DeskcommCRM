/**
 * Os roteiros de atendimento (#1130) chegaram em partes, e o PR 2 recusava
 * ligar o módulo até a tela existir. Com as telas (PR 3), quem administra o
 * servidor liga e desliga os dois módulos opcionais aqui.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ upsert: vi.fn(), audit: vi.fn(), escrita: vi.fn() }));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdminEscrita: () => deps.escrita() }));
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

import { EscritaDePlatformAdminNegada } from "@/lib/auth/recusa-de-escrita-de-admin";
import { updateModuloDaInstalacao } from "./updateModuloDaInstalacao";

beforeEach(() => {
  vi.clearAllMocks();
  deps.upsert.mockResolvedValue({ error: null });
  deps.escrita.mockResolvedValue({ user: { id: "eu" } });
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

  it.each(["forbidden_scope", "mfa_required"] as const)(
    "recusa de escrita (%s) VOLTA como resultado — não lança ao error boundary — e nada é gravado",
    async (codigo) => {
      deps.escrita.mockRejectedValue(new EscritaDePlatformAdminNegada(codigo));
      expect(await updateModuloDaInstalacao({ modulo: "banco_externo", ligado: true })).toEqual({ ok: false, error: codigo });
      expect(deps.upsert).not.toHaveBeenCalled();
      expect(deps.audit).not.toHaveBeenCalled();
    },
  );
});
