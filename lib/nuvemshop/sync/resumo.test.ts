import { describe, expect, it } from "vitest";
import type { EstadoDoSync } from "./estado";
import { resumirSync } from "./resumo";

const e = (over: Partial<EstadoDoSync>): EstadoDoSync => ({
  organization_id: "o", status: "idle", run_id: null, run_origem: null, trava_ate: null, cursor_updated_at: null,
  janela_atual_ini: null, janela_atual_fim: null, alvo_fim: null, pedidos_gravados: 0, pedidos_com_erro: 0,
  ultimo_erro: null, ultimo_run_fim: null, ...over,
});

describe("resumirSync", () => {
  it("sem estado → nunca", () => {
    expect(resumirSync(null, 0)).toMatchObject({ situacao: "nunca", totalPedidos: 0 });
  });
  it("backfill (sem cursor) em curso → importando mês N de 12", () => {
    expect(resumirSync(e({ status: "running", janela_atual_ini: "2026-02-08T12:00:00.000Z", alvo_fim: "2026-10-08T12:00:00.000Z" }), 40))
      .toMatchObject({ situacao: "importando", mes: 5, totalPedidos: 40 });
  });
  it("reconciliação em curso → sincronizando", () => {
    expect(resumirSync(e({ status: "running", cursor_updated_at: "2026-10-08T11:00:00.000Z" }), 40).situacao).toBe("sincronizando");
  });
  it("idle com cursor → em dia, carrega última sync e pedidos com erro", () => {
    expect(resumirSync(e({ cursor_updated_at: "x", ultimo_run_fim: "2026-10-08T12:00:00.000Z", pedidos_com_erro: 2 }), 40))
      .toMatchObject({ situacao: "em_dia", ultimaSync: "2026-10-08T12:00:00.000Z", pedidosComErro: 2 });
  });
  it("erro de autorização → frase de reconexão", () => {
    expect(resumirSync(e({ status: "error", ultimo_erro: "auth" }), 0)).toMatchObject({
      situacao: "erro", erro: "A loja revogou o acesso. Desconecte e conecte de novo.",
    });
  });
});
