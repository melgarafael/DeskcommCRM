import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  agendaStallGate,
  BEFORE_SEND_GATES,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

/**
 * O GATE de "vou verificar/confirmar agenda sem checar" — a cura DETERMINÍSTICA para o
 * `AGENDA_SYSTEM_BLOCK` (instrução em texto, `inbound-turn.ts`) sozinho não bastar. Medido
 * em produção, 2026-08-29 (tenant YADEA, `openai/gpt-5.6-terra`): a instrução estava presente
 * e por último no prompt, e o modelo prometeu verificar/confirmar horário sem chamar
 * `crm_find_free_slots`/`crm_book_appointment`/`crm_reschedule_appointment` mesmo assim.
 *
 * `baseCtx` é próprio deste arquivo — mesma decisão de `gate-vazamento-interno.test.ts`
 * (sem fixture compartilhada de `GateContext`, pra um gate não herdar o contexto calibrado
 * para outro).
 */
function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-08-29T13:57:00Z"),
    body: "",
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
    ...overrides,
  };
}

/** As quatro ferramentas de agenda — o agente que tem todas. */
const TODAS = [
  "crm_find_free_slots",
  "crm_book_appointment",
  "crm_reschedule_appointment",
  "crm_find_and_book_appointment",
] as const;
/** O agente de clínica que só olha a agenda. */
const SO_CONSULTA = ["crm_find_free_slots"] as const;

const FRASE_MEDIDA_1 =
  "😄 Isso! Sobre a segunda de manhã, vou verificar as opções de horário para a avaliação " +
  "da sua moto e te passo assim que tiver a confirmação.";
const FRASE_MEDIDA_2 =
  "Cristiano, estou confirmando com a equipe os horários disponíveis para segunda-feira " +
  "de manhã e já te passo as opções.";

describe("agendaStallGate — veta a promessa vazia, nunca a checagem de verdade", () => {
  it("veta a frase medida em produção quando armado e a ferramenta não rodou", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({ agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false }, body: FRASE_MEDIDA_1 }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("agenda_stall_sem_ferramenta");
  });

  it("veta a segunda frase medida (deferência 'com a equipe')", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({ agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false }, body: FRASE_MEDIDA_2 }),
    );
    expect(v.pass).toBe(false);
  });

  it("DESARMADO (campo ausente) é no-op — caller que não conhece agenda não arma nada", () => {
    const v = agendaStallGate.evaluate(baseCtx({ body: FRASE_MEDIDA_1 }));
    expect(v.pass).toBe(true);
  });

  it("agente sem crm_book_appointment (active: false) é no-op mesmo com a frase", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({ agenda: { active: false, ferramentas: TODAS, toolCalledThisTurn: false }, body: FRASE_MEDIDA_1 }),
    );
    expect(v.pass).toBe(true);
  });

  it("a ferramenta JÁ rodou neste turno: a MESMA frase passa — checou de verdade", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({ agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: true }, body: FRASE_MEDIDA_1 }),
    );
    expect(v.pass).toBe(true);
  });

  it("fala legítima sobre agenda, sem promessa vazia, passa mesmo sem a ferramenta ter rodado", () => {
    // "Amanhã, a oficina abre às 9h" — frase real da mesma conversa medida, dita ANTES do
    // lead pedir confirmação. Não é "vou verificar/confirmar": não deve ser vetada.
    const v = agendaStallGate.evaluate(
      baseCtx({
        agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false },
        body: "Amanhã, a oficina abre às 9h. Posso agendar a avaliação para esse horário.",
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("'vou verificar' fora de contexto de agenda (outro assunto) passa — o padrão exige substantivo de agenda por perto", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({
        agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false },
        body: "Vou verificar o seu endereço de entrega e já te retorno.",
      }),
    );
    expect(v.pass).toBe(true);
  });

  // Frase EXATA do incidente original (2026-08-29, tenant YADEA) que deu origem a este
  // gate — uma afirmação de FATO CONSUMADO, não uma promessa de checar. O
  // AGENDA_STALL_PATTERN sozinho não cobre ("vou/estou" + verbo de checagem não aparece
  // aqui), e passava batido mesmo com o gate armado até o AGENDA_CONFIRMED_PATTERN existir.
  it("veta confirmação categórica sem checar de verdade ('está confirmado')", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({
        agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false },
        body: "Perfeito, Cristiano! 😊 Seu agendamento está confirmado para amanhã às 9h.",
      }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("agenda_stall_sem_ferramenta");
    expect(v.reason).toContain("afirmou");
  });

  it("veta a variante 'está certinho' (segunda frase medida do mesmo incidente)", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({
        agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false },
        body: "Confirmando: seu agendamento está certinho para amanhã às 9h.",
      }),
    );
    expect(v.pass).toBe(false);
  });

  it("confirmação categórica passa quando a ferramenta JÁ rodou neste turno", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({
        agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: true },
        body: "Seu agendamento está confirmado para amanhã às 9h.",
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("'o agendamento está uma bagunça' (sem particípio de confirmação) não é falso positivo", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({
        agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false },
        body: "O agendamento está uma bagunça esse mês, mas isso é outro assunto.",
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("a razão do veto nomeia as ferramentas de agenda — o modelo precisa saber QUAL chamar", () => {
    const v = agendaStallGate.evaluate(
      baseCtx({ agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false }, body: FRASE_MEDIDA_1 }),
    );
    if (v.pass) throw new Error("inalcançável");
    expect(v.reason).toContain("crm_find_free_slots");
    expect(v.reason).toContain("crm_book_appointment");
    expect(v.reason).toContain("crm_reschedule_appointment");
    // Desde a #831 há agente que tem SÓ `crm_find_and_book_appointment`. O veto
    // nomeava três ferramentas que ele pode não ter e nunca a que ele tem —
    // mandando o modelo chamar o que não existe na lista dele.
    expect(v.reason).toContain("crm_find_and_book_appointment");
  });

  it("no outro ramo do veto (confirmação categórica) a lista é a mesma", () => {
    // Dois textos, uma lista: o ramo `confirmedSemChecar` monta a frase com a
    // MESMA variável, e é o ramo que o teste da lista não exercitava.
    const v = agendaStallGate.evaluate(
      baseCtx({
        agenda: { active: true, ferramentas: TODAS, toolCalledThisTurn: false },
        body: "Perfeito! Seu agendamento está confirmado para amanhã às 9h.",
      }),
    );
    if (v.pass) throw new Error("inalcançável");
    expect(v.reason).toContain("crm_find_and_book_appointment");
  });

  it("a quem SÓ consulta o veto continua nomeando só a consulta", () => {
    // O agente de clínica que só olha a agenda: cobrar dele uma marcação seria
    // pedir o que ele não tem como fazer.
    const v = agendaStallGate.evaluate(
      baseCtx({ agenda: { active: true, ferramentas: SO_CONSULTA, toolCalledThisTurn: false }, body: FRASE_MEDIDA_1 }),
    );
    if (v.pass) throw new Error("inalcançável");
    expect(v.reason).toContain("crm_find_free_slots");
    expect(v.reason).not.toContain("crm_book_appointment");
    expect(v.reason).not.toContain("crm_find_and_book_appointment");
  });

  it("quem tem SÓ a conjunta ouve o nome da conjunta — e nunca o da avulsa nem o da remarcação", () => {
    // Desde a #831 um dono aparando capacidades para caber no teto de 25 produz
    // exatamente este agente. O veto nomeava uma lista FIXA para todo agente que
    // marca, e mandava este chamar `crm_book_appointment` e
    // `crm_reschedule_appointment`, que ele não tem: o modelo tenta, falha, e a
    // correção vira um segundo defeito. Os DOIS ramos do veto usam a lista.
    const agenda = {
      active: true,
      ferramentas: ["crm_find_free_slots", "crm_find_and_book_appointment"],
      toolCalledThisTurn: false,
    };
    for (const body of [FRASE_MEDIDA_1, "Perfeito! Seu agendamento está confirmado para amanhã às 9h."]) {
      const v = agendaStallGate.evaluate(baseCtx({ agenda, body }));
      if (v.pass) throw new Error("inalcançável");
      expect(v.reason).toContain("crm_find_and_book_appointment");
      expect(v.reason).toContain("crm_find_free_slots");
      expect(v.reason).not.toContain("crm_book_appointment");
      expect(v.reason).not.toContain("crm_reschedule_appointment");
    }
  });

  it("está na cadeia global e é o mesmo objeto exportado", () => {
    expect(BEFORE_SEND_GATES).toContain(agendaStallGate);
  });
});

/**
 * FIAÇÃO — mesmo padrão de `gate-vazamento-interno.test.ts`: prova que o campo chega da
 * fonte real (`send_message` em `inbound-turn.ts`), não só que o gate decide certo isolado.
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);

describe("fiação do gate — a EXECUÇÃO da ferramenta de agenda arma o sinal, não a decisão de chamar", () => {
  it("send_message passa `agenda` calculado a partir de toolIds e da flag de execução", () => {
    const i = FONTE_INBOUND.indexOf("send_message: tool({");
    const j = FONTE_INBOUND.indexOf("update_lead_state: tool({", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    const corpo = FONTE_INBOUND.slice(i, j);
    // Desde a #831 o `send_message` não compara com uma ferramenta só: ele pergunta
    // às duas funções de fiação, e `temFerramentaDeMarcacao` cobre também a que
    // consulta e marca numa chamada só (`crm_find_and_book_appointment`).
    expect(corpo).toMatch(
      /active:\s*agentConfig !== null && temFerramentaDeAgenda\(agentConfig\.toolIds\)/,
    );
    // O veto nomeia a LISTA de ferramentas do agente, não um booleano: a fiação
    // tem de passar o que `ferramentasDeAgendaDoAgente` tira de `toolIds`, e não
    // uma lista escrita à mão.
    expect(corpo).toMatch(
      /ferramentas:\s*agentConfig === null \? \[\] : ferramentasDeAgendaDoAgente\(agentConfig\.toolIds\)/,
    );
    expect(corpo).toMatch(/toolCalledThisTurn:\s*agendaToolCalledThisTurn/);
  });

  it("as três tools de agenda são marcadas na montagem — não só crm_book_appointment", () => {
    expect(FONTE_INBOUND).toMatch(/AGENDA_TOOL_NAMES = new Set\(\[/);
    expect(FONTE_INBOUND).toContain("'crm_find_free_slots'");
    expect(FONTE_INBOUND).toContain("'crm_book_appointment'");
    expect(FONTE_INBOUND).toContain("'crm_reschedule_appointment'");
    expect(FONTE_INBOUND).toContain("'crm_find_and_book_appointment'");
    expect(FONTE_INBOUND).toMatch(/agendaToolCalledThisTurn = true/);
  });
});
