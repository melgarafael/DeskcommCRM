import { describe, expect, it } from "vitest";

/**
 * O fechamento em INSTANTES (`fechamentos-na-grade.ts`).
 *
 * A grade pinta a faixa fechada por instantes, e o motor de horários livres
 * deixa de oferecer horário pelos minutos de parede no fuso da JORNADA. Se as
 * duas contas divergirem, a faixa cinza cai numa hora e a oferta some noutra —
 * e a tela mente sobre o que o cliente vê. O último caso mede o PAR: a faixa
 * que esta conversão produz é exatamente o buraco que o motor abre.
 */
import { fusoDasExcecoes, instantesDaExcecao } from "./fechamentos-na-grade";
import { horariosLivres, type ExcecaoDeData } from "./horarios-livres";

const SP = "America/Sao_Paulo";
const TOQUIO = "Asia/Tokyo";

describe("instantesDaExcecao", () => {
  it("converte a faixa no fuso da regra", () => {
    expect(instantesDaExcecao({ exception_date: "2026-11-03", start_minute: 840, end_minute: 930 }, SP)).toEqual({
      comeca: "2026-11-03T17:00:00.000Z",
      termina: "2026-11-03T18:30:00.000Z",
    });
  });

  it("o dia inteiro termina na meia-noite SEGUINTE, não às 23:59", () => {
    expect(instantesDaExcecao({ exception_date: "2026-11-03", start_minute: 0, end_minute: 1440 }, SP)).toEqual({
      comeca: "2026-11-03T03:00:00.000Z",
      termina: "2026-11-04T03:00:00.000Z",
    });
  });

  it("o mesmo minuto de parede em outro fuso é outro instante", () => {
    expect(
      instantesDaExcecao({ exception_date: "2026-11-03", start_minute: 0, end_minute: 1440 }, TOQUIO),
    ).toEqual({ comeca: "2026-11-02T15:00:00.000Z", termina: "2026-11-03T15:00:00.000Z" });
  });
});

describe("fusoDasExcecoes — o fuso em que o MOTOR lê as exceções", () => {
  it("é o da jornada da pessoa quando ela está legível", () => {
    expect(fusoDasExcecoes({ timezone: TOQUIO, windows: [] }, SP)).toBe(TOQUIO);
  });

  it("sem jornada (linha ausente) ou com jornada ilegível, cai no da organização", () => {
    expect(fusoDasExcecoes(undefined, "America/Manaus")).toBe("America/Manaus");
    expect(fusoDasExcecoes(null, "America/Manaus")).toBe("America/Manaus");
    expect(fusoDasExcecoes({ timezone: "Fuso/Inexistente", windows: [] }, "America/Manaus")).toBe(
      "America/Manaus",
    );
  });
});

describe("o par: a faixa da grade é o buraco que o motor abre", () => {
  it("fechar 14:00–15:00 numa jornada em Tóquio tira da oferta exatamente esses instantes", () => {
    const linha = { exception_date: "2026-11-03", start_minute: 14 * 60, end_minute: 15 * 60 };
    const fuso = fusoDasExcecoes({ timezone: TOQUIO, windows: [{ dow: 2, start: "09:00", end: "18:00" }] }, SP);
    const faixa = instantesDaExcecao(linha, fuso);

    const excecoes: ExcecaoDeData[] = [
      { data: linha.exception_date, indisponivel: true, inicioMinuto: linha.start_minute, fimMinuto: linha.end_minute },
    ];
    const slots = horariosLivres({
      jornada: { timezone: TOQUIO, windows: [{ dow: 2, start: "09:00", end: "18:00" }] },
      excecoes,
      ocupados: [],
      tipo: { duracaoMin: 60, bufferAntesMin: 0, bufferDepoisMin: 0, avisoMinimoMin: 0, intervaloMin: 60, janelaDias: 400 },
      de: new Date("2026-11-03T00:00:00Z"),
      ate: new Date("2026-11-03T23:59:59Z"),
      agora: new Date("2026-10-01T00:00:00Z"),
    });

    const inicios = slots.map((s) => new Date(s.inicio).toISOString());
    // O motor oferece 13:00 e 15:00 de Tóquio e NÃO 14:00 — e 14:00 de Tóquio é
    // o `comeca` que a grade pinta.
    expect(inicios).toContain("2026-11-03T04:00:00.000Z");
    expect(inicios).toContain("2026-11-03T06:00:00.000Z");
    expect(inicios).not.toContain(faixa.comeca);
    expect(faixa).toEqual({ comeca: "2026-11-03T05:00:00.000Z", termina: "2026-11-03T06:00:00.000Z" });
  });
});
