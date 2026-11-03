/**
 * A DURAÇÃO ESCOLHIDA NA MARCAÇÃO (issue #3709) — o que o motor faz com ela.
 *
 * ─── A frase que este arquivo prova ────────────────────────────────────────
 *
 * "Se a pessoa escolhe 90 minutos, o slot tem de exigir 90 minutos livres."
 *
 * Ela é fácil de escrever e difícil de cumprir, porque a tentação é gravar o
 * campo e deixar a grade no tamanho do molde. Aí o horário oferecido às 09:00
 * (livre por 30 minutos, com outro paciente às 09:30) continua na lista, a
 * pessoa marca, e duas pessoas chegam na mesma cadeira. Os casos abaixo medem
 * exatamente esse encavalamento — e não a existência do campo.
 *
 * ─── O que NÃO é provado aqui ──────────────────────────────────────────────
 *
 * O caminho HTTP (rota, Zod, INSERT) precisa de banco e mora em `tests/db`. O
 * que mora aqui é a CONTA: a régua dos 5…1440 minutos e o motor de horários,
 * que é onde o defeito de verdade estava. `agora` é injetado e nenhuma asserção
 * lê o relógio do processo (o motivo está no cabeçalho de
 * `tests/unit/agenda-horarios-livres.test.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  DURACAO_MAXIMA_MIN,
  DURACAO_MINIMA_MIN,
  duracaoEscolhidaValida,
} from "@/lib/agenda/duracao-escolhida";
import { partesNoFuso } from "@/lib/agenda/fuso";
import {
  horariosLivres,
  type JornadaDaAgenda,
  type Ocupado,
  type Slot,
  type TipoDeAgendamento,
} from "@/lib/agenda/horarios-livres";

const SP = "America/Sao_Paulo";

/** Segunda-feira, 09:00–12:00. Uma janela só, para a conta ficar legível. */
const MANHA: JornadaDaAgenda = {
  timezone: SP,
  windows: [{ dow: 1, start: "09:00", end: "12:00" }],
};

/** O molde do serviço: 30 minutos, grade de meia em meia hora. */
const CONSULTA_DE_30: TipoDeAgendamento = {
  duracaoMin: 30,
  bufferAntesMin: 0,
  bufferDepoisMin: 0,
  avisoMinimoMin: 0,
  janelaDias: 60,
};

/** 2026-03-09 é segunda-feira. O dia inteiro, como intervalo de consulta. */
const DIA = { de: new Date("2026-03-09T00:00:00Z"), ate: new Date("2026-03-09T23:59:59Z") };
const AGORA = new Date("2026-03-01T12:00:00Z");

function horas(slots: Slot[]): string[] {
  return slots.map((s) => {
    const p = partesNoFuso(s.inicio, SP);
    return `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
  });
}

/** Comprimento de cada slot, em minutos — o número que a issue pede. */
function minutosDeCada(slots: Slot[]): number[] {
  return slots.map((s) => (s.fim.getTime() - s.inicio.getTime()) / 60_000);
}

function grade(extra: { duracaoMin?: number | null; ocupados?: Ocupado[]; tipo?: TipoDeAgendamento } = {}) {
  return horariosLivres({
    jornada: MANHA,
    excecoes: [],
    ocupados: extra.ocupados ?? [],
    tipo: extra.tipo ?? CONSULTA_DE_30,
    ...DIA,
    agora: AGORA,
    // `duracaoMin` só entra quando o caso pede: é assim que o chamador antigo
    // (sem escolha) continua idêntico ao que era antes desta entrega.
    ...(extra.duracaoMin !== undefined ? { duracaoMin: extra.duracaoMin } : {}),
  });
}

describe("a duração escolhida é o comprimento do slot", () => {
  it("90 minutos geram slots de 90 minutos, e não de 30", () => {
    const slots = grade({ duracaoMin: 90 });
    expect(minutosDeCada(slots)).toEqual([90, 90, 90, 90]);
    // 09:00, 09:30, 10:00 e 10:30: o de 11:00 terminaria 12:30, fora da janela.
    expect(horas(slots)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  it("sem escolha, vale a duração do serviço — o padrão não mudou", () => {
    expect(minutosDeCada(grade())).toEqual([30, 30, 30, 30, 30, 30]);
    expect(horas(grade())).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
  });

  it("o PASSO da grade não anda com a duração escolhida — só o que ela exige", () => {
    // A âncora é a janela publicada (09:00 e de meia em meia hora). Escolher 90
    // não pode mover a régua para 09:00/10:30/12:00: o dono da agenda perderia
    // a granularidade que ele mesmo configurou.
    const com90 = horas(grade({ duracaoMin: 90 }));
    expect(com90.slice(0, 2)).toEqual(["09:00", "09:30"]);
  });

  it("o intervalo explícito do tipo continua mandando no passo", () => {
    const slots = grade({ duracaoMin: 60, tipo: { ...CONSULTA_DE_30, intervaloMin: 15 } });
    expect(horas(slots)).toEqual([
      "09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45", "11:00",
    ]);
    expect(minutosDeCada(slots).every((m) => m === 60)).toBe(true);
  });
});

describe("a duração escolhida não pode encavalar outro compromisso", () => {
  /** Consulta das 10:00 às 10:30 — 30 minutos ocupados no meio da manhã. */
  const OCUPADO_10H: Ocupado[] = [
    { inicio: new Date("2026-03-09T13:00:00Z"), fim: new Date("2026-03-09T13:30:00Z") },
  ];

  it("para 30 minutos o compromisso não atrapalha nada além do próprio horário", () => {
    expect(horas(grade({ ocupados: OCUPADO_10H }))).toEqual([
      "09:00", "09:30", "10:30", "11:00", "11:30",
    ]);
  });

  it("para 90 minutos, o 09:00 e o 09:30 somem — eles invadiriam o compromisso", () => {
    // 09:00+90 = 10:30, que cruza o compromisso das 10:00; 09:30+90 = 11:00, idem.
    // Sem esta conta o motor ofereceria os dois e a marcação aconteceria EM CIMA
    // do paciente das 10:00 — que é o defeito que a issue descreve.
    expect(horas(grade({ duracaoMin: 90, ocupados: OCUPADO_10H }))).toEqual(["10:30"]);
  });

  it("o buraco livre de 60 minutos não oferece nada para 90 e oferece para 60", () => {
    // Dois compromissos deixam SÓ 10:00–11:00 vago. Cabe um atendimento de 60
    // minutos; um de 90 não cabe em lugar nenhum da manhã.
    const doisOcupados: Ocupado[] = [
      { inicio: new Date("2026-03-09T12:00:00Z"), fim: new Date("2026-03-09T13:00:00Z") }, // 09:00–10:00
      { inicio: new Date("2026-03-09T14:00:00Z"), fim: new Date("2026-03-09T15:00:00Z") }, // 11:00–12:00
    ];
    expect(horas(grade({ duracaoMin: 60, ocupados: doisOcupados }))).toEqual(["10:00"]);
    expect(grade({ duracaoMin: 90, ocupados: doisOcupados })).toEqual([]);
  });

  it("o buffer do tipo infla o slot do tamanho escolhido, não o do molde", () => {
    // Compromisso vizinho às 11:30. Com 15 minutos de folga DEPOIS do
    // atendimento, um bloco de 90 que termina 11:30 já não serve.
    const vizinho: Ocupado[] = [
      { inicio: new Date("2026-03-09T14:30:00Z"), fim: new Date("2026-03-09T15:00:00Z") }, // 11:30–12:00
    ];
    const slots = grade({
      duracaoMin: 90,
      ocupados: vizinho,
      tipo: { ...CONSULTA_DE_30, bufferDepoisMin: 15 },
    });
    // 09:00→10:30 e 09:30→11:00 cabem; 10:00→11:30 + 15 = 11:45 já toca o vizinho.
    expect(horas(slots)).toEqual(["09:00", "09:30"]);
  });
});

describe("a faixa de 5 a 1440 minutos é uma régua só", () => {
  it("aceita as pontas e o meio", () => {
    expect(duracaoEscolhidaValida(DURACAO_MINIMA_MIN)).toBe(true);
    expect(duracaoEscolhidaValida(90)).toBe(true);
    expect(duracaoEscolhidaValida(DURACAO_MAXIMA_MIN)).toBe(true);
  });

  it("recusa fora da faixa, fracionário e o que não é número", () => {
    // O `check` do banco recusa os mesmos valores: a tela não pode ser a única
    // a saber, nem a última.
    expect(duracaoEscolhidaValida(4)).toBe(false);
    expect(duracaoEscolhidaValida(1441)).toBe(false);
    expect(duracaoEscolhidaValida(0)).toBe(false);
    expect(duracaoEscolhidaValida(-30)).toBe(false);
    expect(duracaoEscolhidaValida(30.5)).toBe(false);
    expect(duracaoEscolhidaValida(Number.NaN)).toBe(false);
    expect(duracaoEscolhidaValida(Number.POSITIVE_INFINITY)).toBe(false);
    expect(duracaoEscolhidaValida("90")).toBe(false);
    expect(duracaoEscolhidaValida(null)).toBe(false);
    expect(duracaoEscolhidaValida(undefined)).toBe(false);
  });

  it("um valor inválido que escape do chamador NÃO vira slot absurdo", () => {
    // Cinto do motor: `0` e `NaN` não podem gerar slot de duração zero (que
    // colidiria com nada e ofereceria o dia inteiro). Cai no molde.
    expect(minutosDeCada(grade({ duracaoMin: 0 }))).toEqual([30, 30, 30, 30, 30, 30]);
    expect(minutosDeCada(grade({ duracaoMin: 3 }))).toEqual([30, 30, 30, 30, 30, 30]);
    expect(minutosDeCada(grade({ duracaoMin: null }))).toEqual([30, 30, 30, 30, 30, 30]);
  });
});

describe("a janela do pedido continua sendo respeitada com a duração escolhida", () => {
  it("o slot não passa do fim da janela publicada", () => {
    // 10:00 + 90 = 11:30 (cabe); 10:30 + 90 = 12:00 (cabe, encosta); 11:00 não
    // é gerado porque já passou do fim.
    const slots = grade({ duracaoMin: 90 });
    const ultimo = slots[slots.length - 1]!;
    const fim = partesNoFuso(ultimo.fim, SP);
    expect(`${String(fim.hora).padStart(2, "0")}:${String(fim.minuto).padStart(2, "0")}`).toBe("12:00");
  });

  it("um horário que só cabe em 30 minutos não é oferecido quando a janela é de 45", () => {
    const curta: JornadaDaAgenda = {
      timezone: SP,
      windows: [{ dow: 1, start: "09:00", end: "09:45" }],
    };
    const slots = horariosLivres({
      jornada: curta,
      excecoes: [],
      ocupados: [],
      tipo: CONSULTA_DE_30,
      ...DIA,
      agora: AGORA,
      duracaoMin: 45,
    });
    expect(horas(slots)).toEqual(["09:00"]);
    expect(minutosDeCada(slots)).toEqual([45]);
  });
});
