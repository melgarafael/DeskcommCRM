/**
 * TURNO MUDO — quando o silêncio do turno é decisão e quando é defeito.
 *
 * A regra é de `lib/agent-engine/agent/turno-mudo.ts`; o caminho inteiro (o
 * handler de `inbound_turn` pedindo a correção ao modelo) está em
 * `tests/invariants/turno-mudo-pede-uma-correcao.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { CORRECAO_DO_TURNO_MUDO, turnoMudoPedeCorrecao } from "@/lib/agent-engine/agent/turno-mudo";

const MUDO = {
  tentativasDeEnvio: 0,
  enviadas: 0,
  turnoDescartado: false,
  passouParaAEquipe: false,
  capDeEnvio: false,
};

describe("o turno mudo pede correção só quando nada explica o silêncio", () => {
  it("⭐ nenhum envio, nenhuma tentativa, nenhuma razão: pede correção", () => {
    expect(turnoMudoPedeCorrecao(MUDO)).toBe(true);
  });

  it.each([
    ["o modelo tentou enviar (a cadeia vetou ou o teto barrou)", { tentativasDeEnvio: 1 }],
    ["algo saiu", { enviadas: 1 }],
    ["o turno foi descartado como obsoleto", { turnoDescartado: true }],
    ["a conversa foi passada à equipe", { passouParaAEquipe: true }],
    ["o cap de envio do número barrou", { capDeEnvio: true }],
  ])("silêncio com razão — %s: não pede", (_razao, mudanca) => {
    expect(turnoMudoPedeCorrecao({ ...MUDO, ...mudanca })).toBe(false);
  });

  it("a correção diz o que aconteceu, manda usar send_message e deixa o silêncio deliberado possível", () => {
    expect(CORRECAO_DO_TURNO_MUDO).toContain("send_message");
    expect(CORRECAO_DO_TURNO_MUDO).toContain("não chega");
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/idioma da conversa/);
    expect(CORRECAO_DO_TURNO_MUDO).toMatch(/não responder, encerre/);
  });
});
