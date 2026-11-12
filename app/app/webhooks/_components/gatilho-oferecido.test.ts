/**
 * #4409 — o gatilho de ligação perdida só é OFERECIDO a quem tem telefonia.
 *
 * A telefonia vem desligada por padrão; sem ela o worker de voz não roda e
 * `voice_call.missed` nunca dispara. A régua é a mesma de `acaoOferecida`: a
 * capacidade ligada mostra, a desligada esconde, e o gatilho já gravado na
 * regra continua na lista.
 *
 * SABOTAGEM: apagar a linha `"voice_call.missed": "telefonia"` de
 * `CAPACIDADE_DO_GATILHO` deixa o caso "sem telefonia" vermelho.
 */
import { describe, expect, it } from "vitest";

import { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
import { gatilhoOferecido } from "./labels";

describe("gatilhoOferecido", () => {
  it("sem telefonia, a ligação perdida não aparece", () => {
    expect(gatilhoOferecido("voice_call.missed", [])).toBe(false);
    expect(gatilhoOferecido("voice_call.missed", undefined)).toBe(false);
    expect(gatilhoOferecido("voice_call.missed", ["propostas"])).toBe(false);
  });

  it("com telefonia, a ligação perdida aparece", () => {
    expect(gatilhoOferecido("voice_call.missed", ["telefonia"])).toBe(true);
  });

  it("a regra que já grava o gatilho continua mostrando-o", () => {
    expect(gatilhoOferecido("voice_call.missed", [], "voice_call.missed")).toBe(true);
  });

  it("os gatilhos sem capacidade aparecem para todo mundo", () => {
    const outros = TRIGGER_EVENTS.filter((ev) => ev !== "voice_call.missed");
    expect(outros.length).toBeGreaterThan(0);
    for (const ev of outros) expect(gatilhoOferecido(ev, [])).toBe(true);
  });
});
