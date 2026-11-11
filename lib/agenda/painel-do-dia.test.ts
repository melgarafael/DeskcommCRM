/**
 * O PAINEL DO DIA — reservas por turma, pessoas esperadas e % de confirmadas.
 *
 * Issue #4029, saída 3: uma leitura só, do dia da ORGANIZAÇÃO. O que este
 * arquivo trava, e por quê:
 *
 *  (a) "pessoas esperadas" tem RÉGUA, e ela é a soma de `service_party_size` das
 *      reservas vivas — não a soma das capacidades. Capacidade é lotação da
 *      turma e é publicada à parte; usá-la como "pessoas esperadas" diria que a
 *      clínica espera 10 pacientes numa turma em que ninguém reservou.
 *  (b) percentual de confirmadas com 0, 1 e 3 reservas — inclusive o zero, que
 *      é o caso em que a divisão seria por zero.
 *  (c) dia vazio devolve estrutura VAZIA (não `null`) e percentual explícito.
 *  (d) o dia é o da ORGANIZAÇÃO: 23h de Brasília tem de cair no dia certo, e
 *      00:30 do dia seguinte não pode cair no dia anterior.
 */
import { describe, expect, it } from "vitest";

import { resumirPainelDoDia, type ReservaDoPainel } from "./painel-do-dia";

const BRASILIA = "America/Sao_Paulo";

/** Uma reserva de turma, com os campos que o painel lê. */
function reserva(over: Partial<ReservaDoPainel> & { id: string }): ReservaDoPainel {
  return {
    inicio: "2026-11-08T13:00:00.000Z",
    fim: "2026-11-08T14:00:00.000Z",
    situacao: "confirmed",
    turmaId: "turma-a",
    turma: "Manhã",
    capacidade: 8,
    pessoas: 1,
    ...over,
  };
}

describe("resumirPainelDoDia", () => {
  it("(a) soma pessoas esperadas pela RÉGUA (party_size), com a capacidade de cada turma à parte", () => {
    const painel = resumirPainelDoDia("2026-11-08", BRASILIA, [
      reserva({ id: "r1", turmaId: "turma-a", turma: "Manhã", capacidade: 8, pessoas: 2 }),
      reserva({ id: "r2", turmaId: "turma-a", turma: "Manhã", capacidade: 8, pessoas: 1 }),
      reserva({ id: "r3", turmaId: "turma-b", turma: "Tarde", capacidade: 4, pessoas: 3, situacao: "pending" }),
    ]);

    expect(painel.linhas).toHaveLength(2);
    const [manha, tarde] = painel.linhas;
    expect(manha).toMatchObject({ turmaId: "turma-a", capacidade: 8, reservas: 2, pessoasEsperadas: 3, confirmadas: 2 });
    expect(tarde).toMatchObject({ turmaId: "turma-b", capacidade: 4, reservas: 1, pessoasEsperadas: 3, confirmadas: 0 });

    // A régua: pessoas são as reservas (2+1 e 3), capacidade é a lotação (8 e 4).
    expect(painel.totais.pessoasEsperadas).toBe(6);
    expect(painel.totais.capacidade).toBe(12);
    expect(painel.totais.pessoasEsperadas).not.toBe(painel.totais.capacidade);
  });

  it("(b) percentual de confirmadas com 0, 1 e 3 reservas", () => {
    expect(resumirPainelDoDia("2026-11-08", BRASILIA, []).totais.percentual).toBeNull();

    const uma = resumirPainelDoDia("2026-11-08", BRASILIA, [reserva({ id: "r1" })]);
    expect(uma.totais).toMatchObject({ reservas: 1, confirmadas: 1, percentual: 100 });

    const tres = resumirPainelDoDia("2026-11-08", BRASILIA, [
      reserva({ id: "r1", situacao: "confirmed" }),
      reserva({ id: "r2", situacao: "confirmed" }),
      reserva({ id: "r3", situacao: "pending" }),
    ]);
    expect(tres.totais).toMatchObject({ reservas: 3, confirmadas: 2, percentual: 67 });

    const umaDeTres = resumirPainelDoDia("2026-11-08", BRASILIA, [
      reserva({ id: "r1", situacao: "confirmed" }),
      reserva({ id: "r2", situacao: "pending" }),
      reserva({ id: "r3", situacao: "pending" }),
    ]);
    expect(umaDeTres.totais.percentual).toBe(33);
  });

  it("(c) dia vazio devolve estrutura vazia e percentual explícito — sem divisão por zero", () => {
    const painel = resumirPainelDoDia("2026-11-08", BRASILIA, []);
    expect(painel).toMatchObject({ dia: "2026-11-08", fuso: BRASILIA, vazio: true, linhas: [] });
    expect(painel.linhas).toEqual([]);
    expect(painel.totais).toEqual({
      turmas: 0,
      reservas: 0,
      pessoasEsperadas: 0,
      confirmadas: 0,
      capacidade: 0,
      percentual: null,
    });
    expect(Number.isNaN(painel.totais.percentual as unknown as number)).toBe(false);
  });

  it("(d) o dia é o da ORGANIZAÇÃO: 23h de Brasília cai no dia certo, 00:30 não", () => {
    const painel = resumirPainelDoDia("2026-11-08", BRASILIA, [
      // 2026-11-08 23:00 em Brasília (UTC-3) — é do dia 8.
      reserva({ id: "r-noite", inicio: "2026-11-09T02:00:00.000Z", fim: "2026-11-09T03:00:00.000Z" }),
      // 2026-11-09 00:30 em Brasília — já é do dia 9.
      reserva({ id: "r-madrugada", inicio: "2026-11-09T03:30:00.000Z", fim: "2026-11-09T04:30:00.000Z" }),
      // 2026-11-07 23:00 em Brasília — é da VÉSPERA.
      reserva({ id: "r-vespera", inicio: "2026-11-08T02:00:00.000Z", fim: "2026-11-08T03:00:00.000Z" }),
    ]);

    expect(painel.totais.reservas).toBe(1);
    expect(painel.linhas[0]?.inicio).toBe("2026-11-09T02:00:00.000Z");

    const proximo = resumirPainelDoDia("2026-11-09", BRASILIA, [
      reserva({ id: "r-madrugada", inicio: "2026-11-09T03:30:00.000Z", fim: "2026-11-09T04:30:00.000Z" }),
    ]);
    expect(proximo.totais.reservas).toBe(1);
  });

  it("cancelada e no_show não são reservas do dia — não inflam denominador nem pessoas", () => {
    const painel = resumirPainelDoDia("2026-11-08", BRASILIA, [
      reserva({ id: "r1", situacao: "confirmed" }),
      reserva({ id: "r2", situacao: "cancelled", pessoas: 5 }),
      reserva({ id: "r3", situacao: "no_show", pessoas: 5 }),
    ]);
    expect(painel.totais).toMatchObject({ reservas: 1, pessoasEsperadas: 1, confirmadas: 1, percentual: 100 });
  });
});
