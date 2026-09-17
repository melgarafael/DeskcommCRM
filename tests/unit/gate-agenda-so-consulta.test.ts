/**
 * O gate de agenda vale para quem SÓ CONSULTA, não só para quem marca.
 *
 * O defeito: `agenda.active` era literalmente "o agente tem
 * `crm_book_appointment`". Existe um arranjo legítimo e comum — clínica, salão,
 * consultório — em que essa ferramenta é negada de propósito, porque o negócio
 * quer que uma PESSOA confirme cada horário. Esse agente recebe
 * `crm_find_free_slots`, promete "vou verificar e te aviso" exatamente igual, e
 * ficava sem a única cura determinística que existe para isso.
 *
 * O sintoma é mudo: o gate passa, a mensagem sai, e ninguém sabe que a garantia
 * que o produto anuncia não estava armada naquele agente.
 */
import { describe, expect, it } from "vitest";

import { agendaStallGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { temFerramentaDeAgenda } from "@/lib/agent-engine/agent/inbound-turn";

// As duas frases medidas em produção que deram origem ao gate.
const PROMESSA = "Vou verificar o horário e já te aviso!";
const CONFIRMOU = "Prontinho, seu horário está confirmado para quinta!";
/** As ferramentas de agenda do agente que só consulta. */
const SO_CONSULTA = ["crm_find_free_slots"] as const;

/**
 * Este arquivo mora em `tests/unit/` e não ao lado do gate por uma razão
 * mecânica: montar um `GateContext` exige dar um valor a `provider`, e
 * `scripts/lint-channels.ts` proíbe nomear provider dentro de `lib/` (ROOTS =
 * app, lib, components, workers). O teste irmão do MESMO gate,
 * `tests/unit/gate-agenda-stall.test.ts`, já mora aqui pelo mesmo motivo.
 *
 * `baseCtx` é próprio deste arquivo, pela mesma razão escrita em
 * `tests/unit/gate-agenda-stall.test.ts`: sem fixture compartilhada de
 * `GateContext`, para um gate não herdar o contexto calibrado para outro.
 *
 * A versão original deste helper devolvia `{ agenda, body } as Parameters<…>[0]`,
 * e o `tsc` recusava (TS2352, "neither type sufficiently overlaps"). O cast
 * escondia duas coisas ao mesmo tempo: faltavam `now`, `optedOut`, `provider` e
 * mais nove campos obrigatórios, e sobrava `body` DENTRO de `agenda`, que a
 * interface não tem. O defeito não apareceu no CI do PR porque a execução dele
 * nunca chegou a rodar — foi a medição do lote que o revelou.
 */
function ctx(over: {
  active: boolean;
  ferramentas: readonly string[];
  toolCalledThisTurn: boolean;
  body: string;
}): GateContext {
  const { body, ...agenda } = over;
  return {
    now: new Date("2026-09-14T12:00:00Z"),
    body,
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    agenda,
  };
}

describe("temFerramentaDeAgenda", () => {
  it("conta a de consultar, e não só a de marcar", () => {
    expect(temFerramentaDeAgenda(["crm_find_free_slots"])).toBe(true);
    expect(temFerramentaDeAgenda(["crm_book_appointment"])).toBe(true);
    expect(temFerramentaDeAgenda(["crm_reschedule_appointment"])).toBe(true);
  });

  it("quem não tem ferramenta de agenda nenhuma segue desarmado", () => {
    // Vetá-lo não teria cura: não há ferramenta que ele possa chamar.
    expect(temFerramentaDeAgenda(["crm_get_contact", "crm_list_pipelines"])).toBe(false);
    expect(temFerramentaDeAgenda([])).toBe(false);
  });
});

describe("agendaStallGate no agente que só consulta", () => {
  it("veta a promessa de verificar sem ter consultado", () => {
    const v = agendaStallGate.evaluate(
      ctx({ active: true, ferramentas: SO_CONSULTA, toolCalledThisTurn: false, body: PROMESSA }),
    );
    expect(v.pass).toBe(false);
  });

  it("veta afirmar que está confirmado — ele nem pode confirmar", () => {
    const v = agendaStallGate.evaluate(
      ctx({ active: true, ferramentas: SO_CONSULTA, toolCalledThisTurn: false, body: CONFIRMOU }),
    );
    expect(v.pass).toBe(false);
  });

  it("passa depois de a consulta ter rodado no turno", () => {
    const v = agendaStallGate.evaluate(
      ctx({ active: true, ferramentas: SO_CONSULTA, toolCalledThisTurn: true, body: PROMESSA }),
    );
    expect(v.pass).toBe(true);
  });

  it("o veto NÃO manda chamar uma ferramenta que ele não tem", () => {
    // Ensinar `crm_book_appointment` a quem não a tem faz o modelo tentar,
    // falhar, e a correção vira um segundo defeito.
    const v = agendaStallGate.evaluate(
      ctx({ active: true, ferramentas: SO_CONSULTA, toolCalledThisTurn: false, body: PROMESSA }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) return;
    expect(v.reason).toContain("crm_find_free_slots");
    expect(v.reason).not.toContain("crm_book_appointment");
    expect(v.reason).not.toContain("crm_reschedule_appointment");
  });

  it("quem PODE marcar vê no veto a ferramenta de marcar que tem", () => {
    const v = agendaStallGate.evaluate(
      ctx({
        active: true,
        ferramentas: ["crm_find_free_slots", "crm_book_appointment"],
        toolCalledThisTurn: false,
        body: PROMESSA,
      }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) return;
    expect(v.reason).toContain("crm_book_appointment");
  });
});
