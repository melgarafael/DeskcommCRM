import { describe, expect, it } from "vitest";

import { evaluateConditions } from "./conditions";

/**
 * AS DUAS CONDIÇÕES DO CONTATO — o que elas respondem (#3814).
 *
 * Este arquivo é só de SEMÂNTICA: os fatos entram prontos, como o motor os
 * entrega (`carregarFatosDoContato`), e o que se prova é a resposta da regra.
 * A leitura em si — a consulta, a fonte de verdade e a ausência de N+1 — mora
 * em `fatos-do-contato.test.ts`.
 *
 * Os tipos são locais de propósito: é este arquivo que roda na `origin/main`
 * para provar o vermelho, e lá o tipo `FatosDoContato` ainda não existe.
 */
type Horario = { starts_at: string; tipo: string | null };
type Fatos = {
  agora: string;
  inscricao_viva: boolean | null;
  horarios: Horario[] | null;
};

/** 02/11/2026 12:00 UTC — o "agora" de todas as janelas. */
const AGORA = "2026-11-02T12:00:00.000Z";

const fatos = (parcial: Partial<Fatos> = {}): Fatos => ({
  agora: AGORA,
  inscricao_viva: false,
  horarios: [],
  ...parcial,
});

/** Só as condições importam; o contexto do evento, quando há, entra vazio. */
const avalia = (conditions: unknown, f: Fatos, contexto: Record<string, unknown> = {}) =>
  evaluateConditions(conditions as never, contexto, f as never);

const FOLLOW_UP = "contato.followup_vivo";
const HORARIO = "contato.horario_marcado";

describe("condição 'Contato tem follow-up vivo'", () => {
  it("responde sim para quem tem inscrição viva e não para quem não tem", () => {
    const sim = [{ field: FOLLOW_UP, op: "eq", value: "sim" }];

    // O controle positivo vem primeiro: é ele que deixa o vermelho honesto na
    // main, onde toda condição desconhecida responde "não".
    expect(avalia(sim, fatos({ inscricao_viva: true }))).toBe(true);
    expect(avalia(sim, fatos({ inscricao_viva: false }))).toBe(false);
  });

  it("o espelho 'não' responde o contrário — é a regra de reserva", () => {
    const nao = [{ field: FOLLOW_UP, op: "eq", value: "nao" }];

    expect(avalia(nao, fatos({ inscricao_viva: false }))).toBe(true);
    expect(avalia(nao, fatos({ inscricao_viva: true }))).toBe(false);
  });

  it("fato não medido (leitura falhou) não decide nos dois sentidos", () => {
    const sim = [{ field: FOLLOW_UP, op: "eq", value: "sim" }];
    const nao = [{ field: FOLLOW_UP, op: "eq", value: "nao" }];
    const naoMedido = fatos({ inscricao_viva: null });

    // Controle: com o fato medido, a resposta existe...
    expect(avalia(sim, fatos({ inscricao_viva: true }))).toBe(true);
    expect(avalia(nao, fatos({ inscricao_viva: false }))).toBe(true);
    // ...e sem ele, nem a regra que inicia o fluxo nem a de reserva disparam:
    // adivinhar "não tem" mandaria a ação bater no 23505 que a condição evita.
    expect(avalia(sim, naoMedido)).toBe(false);
    expect(avalia(nao, naoMedido)).toBe(false);
  });

  it("combina por E com as condições de campo do evento", () => {
    const regra = [
      { field: FOLLOW_UP, op: "eq", value: "nao" },
      { field: "lead.title", op: "eq", value: "Bia" },
    ];
    const contexto = { lead: { title: "Bia" } };

    expect(avalia(regra, fatos({ inscricao_viva: false }), contexto)).toBe(true);
    expect(avalia(regra, fatos({ inscricao_viva: true }), contexto)).toBe(false);
  });
});

describe("condição 'Contato tem horário marcado'", () => {
  const horario = (iso: string, tipo: string | null = "Consulta"): Horario => ({
    starts_at: iso,
    tipo,
  });

  it("horário dentro dos próximos N dias responde sim; fora da janela, não", () => {
    const cond = [{ field: HORARIO, op: "eq", value: "sim|7" }];
    const dentro = fatos({ horarios: [horario("2026-11-05T09:00:00.000Z")] });
    // 20/12 está a 48 dias: fora da janela de 7.
    const fora = fatos({ horarios: [horario("2026-12-20T09:00:00.000Z")] });

    expect(avalia(cond, dentro)).toBe(true);
    expect(avalia(cond, fora)).toBe(false);
  });

  it("sem janela, qualquer horário futuro responde sim", () => {
    const cond = [{ field: HORARIO, op: "eq", value: "sim" }];

    expect(avalia(cond, fatos({ horarios: [horario("2027-03-01T09:00:00.000Z")] }))).toBe(true);
    expect(avalia(cond, fatos({ horarios: [] }))).toBe(false);
  });

  it("tipo diferente do pedido responde não — e o mesmo tipo, escrito de outro jeito, responde sim", () => {
    const cond = [{ field: HORARIO, op: "eq", value: "sim||Manutenção" }];

    // O controle positivo usa minúscula sem acento: a comparação é a MESMA
    // normalização de `contains` (#2973), não igualdade de texto.
    expect(
      avalia(cond, fatos({ horarios: [horario("2026-11-06T09:00:00.000Z", "manutencao")] })),
    ).toBe(true);
    expect(
      avalia(cond, fatos({ horarios: [horario("2026-11-06T09:00:00.000Z", "Consulta")] })),
    ).toBe(false);
  });

  it("'não tem horário nos próximos N dias' é a regra de reserva: responde sim só quando não há", () => {
    const cond = [{ field: HORARIO, op: "eq", value: "nao|7" }];

    expect(avalia(cond, fatos({ horarios: [] }))).toBe(true);
    expect(avalia(cond, fatos({ horarios: [horario("2026-11-05T09:00:00.000Z")] }))).toBe(false);
    // O que está longe não conta para a janela curta: continua "não tem".
    expect(avalia(cond, fatos({ horarios: [horario("2026-12-20T09:00:00.000Z")] }))).toBe(true);
  });

  it("agenda não medida (leitura falhou) não decide", () => {
    const sim = [{ field: HORARIO, op: "eq", value: "sim" }];
    const nao = [{ field: HORARIO, op: "eq", value: "nao" }];
    const naoMedido = fatos({ horarios: null });

    expect(avalia(sim, fatos({ horarios: [horario("2026-11-05T09:00:00.000Z")] }))).toBe(true);
    expect(avalia(sim, naoMedido)).toBe(false);
    expect(avalia(nao, naoMedido)).toBe(false);
  });
});
