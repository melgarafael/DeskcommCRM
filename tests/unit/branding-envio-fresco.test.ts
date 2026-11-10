import { beforeEach, describe, expect, it, vi } from "vitest";

const banco = vi.hoisted(() => ({ nome: "Marca antes", leituras: 0 }));
vi.mock("@/lib/env", () => ({ env: { APP_NAME: "Marca de piso" } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const consulta = {
      abortSignal: (_sinal: AbortSignal) => consulta,
      maybeSingle: async () => {
        banco.leituras += 1;
        return {
          data: {
            app_name: banco.nome,
            logo_url: null,
            logo_path: null,
            accent_hex: null,
            show_powered_by: true,
            seeded_from_env: false,
            fallback_at: null,
            fallback_reason: null,
          },
          error: null,
        };
      },
    };
    return { from: () => ({ select: () => ({ eq: () => consulta }) }) };
  },
}));

beforeEach(async () => {
  banco.nome = "Marca antes";
  banco.leituras = 0;
  vi.resetModules();
  (await import("@/lib/branding/instalacao")).invalidarMarcaDaInstalacao();
});

describe("a marca do envio é lida na hora", () => {
  it("envio vê escrita de outro processo e não lê nem substitui o memo da fachada", async () => {
    const { marcaDaSaida } = await import("@/lib/branding/saida");
    expect((await marcaDaSaida(null)).nome).toBe("Marca antes");
    banco.nome = "Marca depois";
    expect((await marcaDaSaida(null, { semMemo: true })).nome).toBe("Marca depois");
    expect((await marcaDaSaida(null)).nome).toBe("Marca antes");
    expect(banco.leituras).toBe(2);
  });
});
