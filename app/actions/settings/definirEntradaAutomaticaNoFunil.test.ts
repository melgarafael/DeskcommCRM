/**
 * A gravação da ENTRADA AUTOMÁTICA NO FUNIL (#3603, fatia 1).
 *
 * O que se prova: quem pode gravar (manager+), de onde vem a organização (da
 * sessão, nunca do argumento), que o funil e a etapa são conferidos contra o
 * BANCO desta organização — jsonb não tem FK para isso —, que o merge preserva o
 * que não é desta chave e que desligar NÃO apaga a etapa escolhida.
 *
 * ─── SABOTAGEM (previsão) ──────────────────────────────────────────────────
 * - Tirar as duas conferências (funil/etapa): caem "funil de outra organização"
 *   e "etapa de outro funil" — e toda conversa nova daquela organização bateria
 *   em `sem_funil` dias depois, sem ninguém entender por quê.
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
const ETAPA = "77777777-7777-4777-8777-777777777777";

/** O `settings` que já estava gravado: tem de sobreviver à troca da chave. */
const SETTINGS_ATUAL = {
  branding: { accent_hex: "#123456" },
  crm: { cliente_pela_agenda: true },
};

let funisDaOrg: string[];
let etapasDoFunil: Array<{ pipeline_id: string; id: string }>;
let escritas: unknown[];

function adminFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let payload: unknown = null;
      const elo: Record<string, unknown> = {};
      elo.select = () => elo;
      elo.eq = (coluna: string, valor: unknown) => {
        if (payload !== null) {
          escritas.push({ tabela, payload, id: valor });
          return Promise.resolve({ error: null });
        }
        filtros[coluna] = valor;
        return elo;
      };
      elo.update = (p: unknown) => {
        payload = p;
        return elo;
      };
      elo.maybeSingle = async () => {
        if (tabela === "organizations")
          return { data: { settings: structuredClone(SETTINGS_ATUAL) }, error: null };
        if (tabela === "crm_pipelines") {
          return {
            data: funisDaOrg.includes(String(filtros.id)) ? { id: filtros.id } : null,
            error: null,
          };
        }
        if (tabela === "crm_stages") {
          const achou = etapasDoFunil.some(
            (e) => e.pipeline_id === filtros.pipeline_id && e.id === filtros.id,
          );
          return { data: achou ? { id: filtros.id } : null, error: null };
        }
        return { data: null, error: null };
      };
      return elo;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  funisDaOrg = [FUNIL];
  etapasDoFunil = [{ pipeline_id: FUNIL, id: ETAPA }];
  escritas = [];
  mocks.createAdminClient.mockReturnValue(adminFalso());
  mocks.loadAuthUser.mockResolvedValue(USER);
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "manager" });
  mocks.mfaEmDivida.mockResolvedValue(false);
});

describe("definirEntradaAutomaticaNoFunil", () => {
  it.each(["viewer", "agent"])("%s é recusado e nada é gravado", async (role) => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role });

    const r = await definirEntradaAutomaticaNoFunil({
      ativa: true,
      pipeline_id: FUNIL,
      stage_id: null,
    });

    expect(r).toEqual({ ok: false, error: "forbidden_role" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("ligar sem funil é recusado antes de qualquer leitura — a tela não promete o que nada faria", async () => {
    const r = await definirEntradaAutomaticaNoFunil({
      ativa: true,
      pipeline_id: null,
      stage_id: null,
    });

    expect(r).toEqual({ ok: false, error: "validation_failed" });
    expect(mocks.loadAuthUser).not.toHaveBeenCalled();
  });

  it("funil de outra organização (ou arquivado) é recusado", async () => {
    funisDaOrg = [];

    const r = await definirEntradaAutomaticaNoFunil({
      ativa: true,
      pipeline_id: FUNIL,
      stage_id: null,
    });

    expect(r).toEqual({ ok: false, error: "funil_invalido" });
    expect(escritas).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("etapa que não é deste funil é recusada", async () => {
    etapasDoFunil = [];

    const r = await definirEntradaAutomaticaNoFunil({
      ativa: true,
      pipeline_id: FUNIL,
      stage_id: ETAPA,
    });

    expect(r).toEqual({ ok: false, error: "etapa_invalida" });
    expect(escritas).toHaveLength(0);
  });

  it("grava a escolha preservando o resto do settings e registra no audit", async () => {
    const r = await definirEntradaAutomaticaNoFunil({
      ativa: true,
      pipeline_id: FUNIL,
      stage_id: ETAPA,
    });

    expect(r).toEqual({ ok: true });
    expect(escritas).toHaveLength(1);
    const gravado = escritas[0] as { id: unknown; payload: { settings: Record<string, unknown> } };
    expect(gravado.id).toBe(ORG);
    expect(gravado.payload.settings).toMatchObject({
      branding: { accent_hex: "#123456" },
      crm: { cliente_pela_agenda: true },
      entrada_automatica_no_funil: { ativa: true, pipeline_id: FUNIL, stage_id: ETAPA },
    });
    expect(mocks.audit).toHaveBeenCalled();
  });

  it("desligar NÃO apaga a etapa escolhida: religar não obriga a escolher de novo", async () => {
    const r = await definirEntradaAutomaticaNoFunil({
      ativa: false,
      pipeline_id: FUNIL,
      stage_id: ETAPA,
    });

    expect(r).toEqual({ ok: true });
    const gravado = escritas[0] as { payload: { settings: Record<string, unknown> } };
    expect(gravado.payload.settings.entrada_automatica_no_funil).toEqual({
      ativa: false,
      pipeline_id: FUNIL,
      stage_id: ETAPA,
    });
  });
});
