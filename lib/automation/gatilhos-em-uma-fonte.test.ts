/**
 * Os gatilhos de automação vivem numa fonte só, e as três pontas concordam.
 *
 * Eram três listas escritas à mão: o enum do Zod (a tela), o mapa de entidade
 * (o guard do motor) e o `events` do handler (a assinatura no dispatcher).
 * Esquecer a terceira é o defeito mais caro dos três, porque ele é MUDO: a
 * regra aparece no seletor, o operador a salva, o evento acontece — e nada
 * roda. Sem erro, sem log, sem run. Só um cliente que não recebeu a mensagem.
 *
 * Este teste não repete a lista: ele prova que as pontas derivam da mesma.
 */
import { describe, expect, it } from "vitest";

import { automationRulesHandler } from "./engine.handler";
import { gatilhoDaTransicao } from "@/lib/agenda/laco";
import { ENTIDADE_ESPERADA_POR_GATILHO, TRIGGER_EVENTS } from "@/lib/schemas/webhooks";

describe("gatilhos de automação", () => {
  it("o handler assina exatamente o que a tela deixa escolher", () => {
    expect([...automationRulesHandler.events].sort()).toEqual([...TRIGGER_EVENTS].sort());
  });

  it("todo gatilho declara a entidade que o guard do motor espera", () => {
    for (const gatilho of TRIGGER_EVENTS) {
      expect(ENTIDADE_ESPERADA_POR_GATILHO[gatilho], gatilho).toBeTruthy();
    }
  });

  it("todo gatilho que a agenda emite é reconhecido pelo motor", () => {
    // A ponta emissora, contra a ponta consumidora. Um `appointment.x` emitido
    // e não declarado é evento sem consumer — anti-pattern nº 3 da doutrina.
    const daAgenda = new Set(
      (
        [
          [null, "pending"],
          [null, "confirmed"],
          ["pending", "confirmed"],
          ["confirmed", "rescheduled"],
          ["confirmed", "cancelled"],
        ] as const
      )
        .map(([de, para]) => gatilhoDaTransicao(de, para))
        .filter((g): g is string => g !== null),
    );

    expect(daAgenda.size).toBeGreaterThan(0);
    for (const gatilho of daAgenda) {
      expect(TRIGGER_EVENTS as readonly string[], gatilho).toContain(gatilho);
      expect(ENTIDADE_ESPERADA_POR_GATILHO[gatilho as keyof typeof ENTIDADE_ESPERADA_POR_GATILHO])
        .toBe("calendar_appointment");
    }
  });
});
