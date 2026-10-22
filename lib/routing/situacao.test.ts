import { describe, expect, it } from "vitest";

import { routingConfigSchema } from "@/lib/schemas/routing";

import { decideRouting } from "./decide";
import { situacaoDoAtendente } from "./situacao";

// Quinta-feira, 22/10/2026, 15h em São Paulo.
const AGORA = new Date("2026-10-22T18:00:00Z");
const BASE = { isAvailable: true, capacity: 5, currentLoad: 1, schedule: null };

describe("situacaoDoAtendente — a mesma conta do roteador, com o porquê", () => {
  it("disponível, sem horário e com folga pode receber", () => {
    expect(situacaoDoAtendente(BASE, AGORA)).toBe("pode_receber");
  });

  it("chave desligada ou sem cadastro é indisponível", () => {
    expect(situacaoDoAtendente({ ...BASE, isAvailable: false }, AGORA)).toBe("indisponivel");
    expect(situacaoDoAtendente({ ...BASE, capacity: null }, AGORA)).toBe("indisponivel");
  });

  it("fora da jornada publicada é fora do horário", () => {
    const soSegunda = { timezone: "America/Sao_Paulo", windows: [{ dow: 1, start: "08:00", end: "18:00" }] };
    expect(situacaoDoAtendente({ ...BASE, schedule: soSegunda }, AGORA)).toBe("fora_do_horario");
    const quinta = { timezone: "America/Sao_Paulo", windows: [{ dow: 4, start: "08:00", end: "18:00" }] };
    expect(situacaoDoAtendente({ ...BASE, schedule: quinta }, AGORA)).toBe("pode_receber");
  });

  it("no limite da capacidade — ou do limite extra do bloco — está lotado", () => {
    expect(situacaoDoAtendente({ ...BASE, currentLoad: 5 }, AGORA)).toBe("lotado");
    expect(situacaoDoAtendente({ ...BASE, currentLoad: 2 }, AGORA, 2)).toBe("lotado");
    expect(situacaoDoAtendente({ ...BASE, currentLoad: 1 }, AGORA, 2)).toBe("pode_receber");
  });
});

describe("modo 'Pelos fluxos de Automações'", () => {
  it("o rodízio da empresa não toca na conversa — quem distribui é o fluxo", () => {
    const config = routingConfigSchema.parse({ mode: "fluxos" });
    const acao = decideRouting({
      mode: "fluxos",
      alreadyAssigned: false,
      eligibles: [{ userId: "a", currentLoad: 0, lastAssignedAt: null }],
      config,
      attempts: 0,
      now: AGORA,
    });
    expect(acao).toEqual({ kind: "skip", reason: "flows_mode" });
  });
});
