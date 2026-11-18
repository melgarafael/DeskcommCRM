/**
 * A gravação da ENTRADA AUTOMÁTICA NO FUNIL (#3603, fatia 1).
 *
 * O que se prova: quem pode gravar (manager+), de onde vem a organização (da
 * sessão, nunca do argumento), que a chave é só o interruptor `{ ativa }` — o
 * destino é o da entrada, opção (a) — e que o merge preserva o que não é desta
 * chave.
 *
 * ─── SABOTAGEM (previsão) ──────────────────────────────────────────────────
 * - Voltar a exigir funil para ligar: cai "ligar sem funil grava".
 * - Trocar o merge por `update({ settings: { entrada_automatica_no_funil } })`:
 *   cai "preserva o resto do settings" (`branding`, `crm`, …).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  resolveActiveOrg: mocks.resolveActiveOrg,
  mfaEmDivida: mocks.mfaEmDivida,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => null }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { definirEntradaAutomaticaNoFunil } from "./definirEntradaAutomaticaNoFunil";

const USER = { id: "00000000-0000-4000-8000-000000000001", support: null };
const ORG = "11111111-1111-4111-8111-111111111111";
const FUNIL = "44444444-4444-4444-8444-444444444444";

/** O `settings` que já estava gravado: tem de sobreviver à troca da chave. */
const SETTINGS_ATUAL = {
  branding: { accent_hex: "#123456" },
  crm: { cliente_pela_agenda: true },
};

let escritas: unknown[];

function adminFalso() {
  return {
    from(tabela: string) {
      let payload: unknown = null;
      const elo: Record<string, unknown> = {};
      elo.select = () => elo;
      elo.eq = (coluna: string, valor: unknown) => {
        if (payload !== null) {
          escritas.push({ tabela, payload, id: valor });
          return Promise.resolve({ error: null });
        }
        return elo;
      };
      elo.update = (p: unknown) => {
        payload = p;
        return elo;
      };
      elo.maybeSingle = async () => {
        if (tabela === "organizations")
          return { data: { settings: structuredClone(SETTINGS_ATUAL) }, error: null };
        return { data: null, error: null };
      };
      return elo;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  escritas = [];
  mocks.createAdminClient.mockReturnValue(adminFalso());
  mocks.loadAuthUser.mockResolvedValue(USER);
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "manager" });
  mocks.mfaEmDivida.mockResolvedValue(false);
});

describe("definirEntradaAutomaticaNoFunil", () => {
  it.each(["viewer", "agent"])("%s é recusado e nada é gravado", async (role) => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role });

    const r = await definirEntradaAutomaticaNoFunil({ ativa: true });

    expect(r).toEqual({ ok: false, error: "forbidden_role" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("entrada que não é booleano é recusada antes de qualquer leitura", async () => {
    const r = await definirEntradaAutomaticaNoFunil({ ativa: "sim" } as never);

    expect(r).toEqual({ ok: false, error: "validation_failed" });
    expect(mocks.loadAuthUser).not.toHaveBeenCalled();
  });

  it("ligar sem funil grava: o destino é o da entrada, preservando o resto do settings", async () => {
    const r = await definirEntradaAutomaticaNoFunil({ ativa: true });

    expect(r).toEqual({ ok: true });
    expect(escritas).toHaveLength(1);
    const gravado = escritas[0] as { id: unknown; payload: { settings: Record<string, unknown> } };
    expect(gravado.id).toBe(ORG);
    expect(gravado.payload.settings).toMatchObject({
      branding: { accent_hex: "#123456" },
      crm: { cliente_pela_agenda: true },
    });
    expect(gravado.payload.settings.entrada_automatica_no_funil).toEqual({ ativa: true });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settings.entrada_automatica_no_funil_updated",
        organizationId: ORG,
        metadata: { ativa: true },
      }),
    );
  });

  it("desligar grava `ativa: false` e descarta o funil de uma versão anterior", async () => {
    const r = await definirEntradaAutomaticaNoFunil({
      ativa: false,
      pipeline_id: FUNIL,
    } as never);

    expect(r).toEqual({ ok: true });
    const gravado = escritas[0] as { payload: { settings: Record<string, unknown> } };
    expect(gravado.payload.settings.entrada_automatica_no_funil).toEqual({ ativa: false });
  });
});
