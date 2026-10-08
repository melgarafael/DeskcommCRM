/**
 * Unit tests for lib/lgpd/sla.ts — computeDueAt
 *
 * Verifies that the LGPD SLA calculator correctly skips:
 *  - Weekends (Saturday + Sunday)
 *  - Brazilian national holidays (fixed and moveable, calculated 2000-2100;
 *    20/11 from 2024 on — Lei 14.759/2023)
 */

import { describe, it, expect } from "vitest";
import { computeDueAt } from "@/lib/lgpd/sla";
import {
  HOLIDAYS_BR_ISO,
  PRIMEIRO_ANO_COBERTO,
  PRIMEIRO_ANO_DA_CONSCIENCIA_NEGRA,
  ULTIMO_ANO_COBERTO,
  feriadosDoBrasilDoAno,
} from "@/lib/lgpd/holidays-br";

/** Parse a YYYY-MM-DD string as a UTC Date */
function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Format a Date back to YYYY-MM-DD (UTC) for assertions */
function fmt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("computeDueAt — business day SLA calculator", () => {
  // -------------------------------------------------------------------------
  // 5 simple cases — no holidays, just weekends
  // -------------------------------------------------------------------------

  it("simple: Mon + 5 business days = next Mon (skips weekend)", () => {
    // 2026-05-04 is Monday; +5 business days = Mon 2026-05-11
    expect(fmt(computeDueAt(d("2026-05-04"), 5))).toBe("2026-05-11");
  });

  it("simple: Wed + 3 business days = Mon (skips weekend)", () => {
    // 2026-05-06 is Wed; +3 = Mon 2026-05-11 (Thu, Fri, Mon)
    expect(fmt(computeDueAt(d("2026-05-06"), 3))).toBe("2026-05-11");
  });

  it("simple: Fri + 2 business days = Tue (skips Sat+Sun)", () => {
    // 2026-05-08 is Fri; +2 = Mon 2026-05-11 and Tue 2026-05-12
    expect(fmt(computeDueAt(d("2026-05-08"), 2))).toBe("2026-05-12");
  });

  it("simple: Tue + 1 business day = Wed", () => {
    // 2026-05-05 is Tue; +1 = Wed 2026-05-06
    expect(fmt(computeDueAt(d("2026-05-05"), 1))).toBe("2026-05-06");
  });

  it("simple: Thu + 10 business days = Thu+2w (spans a weekend)", () => {
    // 2026-05-07 (Thu) + 10 business days: Fri, Mon, Tue, Wed, Thu, Fri, Mon, Tue, Wed, Thu
    // = Thu 2026-05-21
    expect(fmt(computeDueAt(d("2026-05-07"), 10))).toBe("2026-05-21");
  });

  // -------------------------------------------------------------------------
  // Edge: start date is not a business day
  // -------------------------------------------------------------------------

  it("start on Saturday: counting begins next Monday", () => {
    // 2026-05-09 is Saturday → first business day = Mon 2026-05-11
    // +15 from Mon = 3 full weeks = Mon 2026-06-01
    // Mon+15: Tue, Wed, Thu, Fri, Mon, Tue, Wed, Thu, Fri, Mon, Tue, Wed, Thu, Fri, Mon
    // = Mon 2026-06-01
    expect(fmt(computeDueAt(d("2026-05-09"), 15))).toBe("2026-06-01");
  });

  // -------------------------------------------------------------------------
  // Holiday cases
  // -------------------------------------------------------------------------

  it("2026-04-29 (Wed) + 15 úteis: pula Dia do Trabalho 01-05", () => {
    // Wed 2026-04-29 is a business day (first counting day = Thu 30)
    // 01/05 (Fri) is a holiday — skipped
    // Count: Thu30, skip Fri01(holiday), Mon04, Tue05, Wed06, Thu07, Fri08 = 6
    //        Mon11, Tue12, Wed13, Thu14, Fri15 = 11
    //        Mon18, Tue19, Wed20, Thu21 = 15
    // → Thu 2026-05-21... wait, Tiradentes is 04-21 (Tue), not in this window.
    // Let's recount from Thu 2026-04-30:
    //  day1 = Thu 30 Apr
    //  day2 = Fri 01 May? No — 01-May is Trabalho holiday → skip
    //  day2 = Mon 04 May
    //  day3 = Tue 05
    //  day4 = Wed 06
    //  day5 = Thu 07
    //  day6 = Fri 08
    //  day7 = Mon 11
    //  day8 = Tue 12
    //  day9 = Wed 13
    //  day10 = Thu 14
    //  day11 = Fri 15
    //  day12 = Mon 18
    //  day13 = Tue 19
    //  day14 = Wed 20
    //  day15 = Thu 21
    expect(fmt(computeDueAt(d("2026-04-29"), 15))).toBe("2026-05-21");
  });

  it("2026-04-30 (Thu) + 15 úteis pula 01/05 feriado + fim de semana", () => {
    // First day after 04-30: Fri 01 May is holiday → skip
    // Count starts Mon 04 May (day1), same as above but shifted by 1
    // day1=Mon 04, day2=Tue05, day3=Wed06, day4=Thu07, day5=Fri08
    // day6=Mon11, day7=Tue12, day8=Wed13, day9=Thu14, day10=Fri15
    // day11=Mon18, day12=Tue19, day13=Wed20, day14=Thu21, day15=Fri22
    expect(fmt(computeDueAt(d("2026-04-30"), 15))).toBe("2026-05-22");
  });

  it("2026-12-23 (Wed) + 15 úteis pula Natal + Ano Novo", () => {
    // 2026-12-25 = Natal (Fri), 2027-01-01 = Ano Novo (Fri)
    // day1=Thu24, skip Fri25(Natal), skip Sat26, skip Sun27
    // day2=Mon28, day3=Tue29, day4=Wed30, day5=Thu31
    // skip Fri01(AnoNovo), skip Sat02, skip Sun03
    // day6=Mon04, day7=Tue05, day8=Wed06, day9=Thu07, day10=Fri08
    // day11=Mon11, day12=Tue12, day13=Wed13, day14=Thu14, day15=Fri15
    expect(fmt(computeDueAt(d("2026-12-23"), 15))).toBe("2027-01-15");
  });

  it("2026-02-13 (Fri) + 15 úteis pula Carnaval 16-17/02", () => {
    // 2026-02-16 (Mon) = Carnaval Monday — holiday
    // 2026-02-17 (Tue) = Carnaval Tuesday — holiday
    // day1=Sat14? No, Sat → skip. Sun15 → skip.
    // First business day after Fri13: Mon16 is holiday, Tue17 is holiday → Wed18(day1)
    // day1=Wed18, day2=Thu19, day3=Fri20
    // day4=Mon23, day5=Tue24, day6=Wed25, day7=Thu26, day8=Fri27
    // day9=Mon02Mar, day10=Tue03, day11=Wed04, day12=Thu05, day13=Fri06
    // day14=Mon09, day15=Tue10
    expect(fmt(computeDueAt(d("2026-02-13"), 15))).toBe("2026-03-10");
  });

  // -------------------------------------------------------------------------
  // Sanity check on the holiday list
  // -------------------------------------------------------------------------

  it("HOLIDAYS_BR_ISO cobre 12 feriados por ano até 2023 e 13 de 2024 em diante (#2413, #2421)", () => {
    const anosDe12 = PRIMEIRO_ANO_DA_CONSCIENCIA_NEGRA - PRIMEIRO_ANO_COBERTO;
    const anosDe13 = ULTIMO_ANO_COBERTO - PRIMEIRO_ANO_DA_CONSCIENCIA_NEGRA + 1;
    expect(HOLIDAYS_BR_ISO).toHaveLength(12 * anosDe12 + 13 * anosDe13);
    // Amostra dos fixos: a data exata de cada um não muda com o ano.
    for (const data of ["2026-01-01", "2026-04-21", "2026-09-07", "2026-12-25"]) {
      expect(HOLIDAYS_BR_ISO).toContain(data);
    }
  });

  it("o cálculo reproduz os cinco anos que a lista tinha à mão (#2413)", () => {
    // Carnaval (segunda e terça), Sexta-feira Santa e Corpo de Deus, como
    // estavam escritos à mão na tabela antiga — byte a byte.
    const conhecidos: Array<[number, string, string, string, string]> = [
      [2026, "2026-02-16", "2026-02-17", "2026-04-03", "2026-06-04"],
      [2027, "2027-02-08", "2027-02-09", "2027-03-26", "2027-05-27"],
      [2028, "2028-02-28", "2028-02-29", "2028-04-14", "2028-06-15"],
      [2029, "2029-02-12", "2029-02-13", "2029-03-30", "2029-05-31"],
      [2030, "2030-03-04", "2030-03-05", "2030-04-19", "2030-06-20"],
    ];
    for (const [ano, segunda, terca, sextaSanta, corpoDeDeus] of conhecidos) {
      const feriados = feriadosDoBrasilDoAno(ano);
      expect(feriados).toHaveLength(13); // os 12 da lista à mão + o 20/11 (#2421)
      expect(feriados).toContain(segunda);
      expect(feriados).toContain(terca);
      expect(feriados).toContain(sextaSanta);
      expect(feriados).toContain(corpoDeDeus);
    }
  });

  it("o prazo aberto no fim de 2030 salta o 1º de janeiro de 2031 (#2413)", () => {
    // Na lista à mão, 2031 não tinha feriado nenhum: o D+7 de 20/12/2030 caía em 01/01/2031.
    expect(computeDueAt(d("2030-12-20"), 7).toISOString().slice(0, 10)).toBe("2031-01-02");
  });

  it("a cobertura alcança o ano atual + 2 — senão o prazo conta sem feriados (#2413)", () => {
    const alvo = new Date().getFullYear() + 2;
    expect(ULTIMO_ANO_COBERTO).toBeGreaterThanOrEqual(alvo);
    expect(HOLIDAYS_BR_ISO).toContain(`${alvo}-12-25`);
    expect(feriadosDoBrasilDoAno(alvo)).toHaveLength(13);
  });

  // -------------------------------------------------------------------------
  // 20 de novembro — doc 108, A (Lei 14.759/2023): feriado nacional desde 2024
  // -------------------------------------------------------------------------

  it("o 20/11 é feriado de 2024 em diante, e não antes (#2421)", () => {
    expect(PRIMEIRO_ANO_DA_CONSCIENCIA_NEGRA).toBe(2024);
    expect(HOLIDAYS_BR_ISO).not.toContain("2023-11-20");
    expect(feriadosDoBrasilDoAno(2023)).toHaveLength(12);
    for (const ano of [2024, 2026, 2030, 2100]) {
      expect(HOLIDAYS_BR_ISO).toContain(`${ano}-11-20`);
    }
  });

  it("o D+7 que atravessa o 20/11/2026 (sexta) vence um dia depois (#2421)", () => {
    // Aberto seg 16/11: ter17(1) qua18(2) qui19(3) [sex20 feriado] seg23(4)
    // ter24(5) qua25(6) qui26(7). Sem o 20/11, vencia na quarta 25.
    expect(fmt(computeDueAt(d("2026-11-16"), 7))).toBe("2026-11-26");
  });

  it("o D+7 que atravessa o 20/11/2023 NÃO muda — a lei é de dezembro de 2023 (#2421)", () => {
    // Aberto qui 16/11/2023: sex17(1) seg20(2, ainda dia útil) ter21(3) qua22(4)
    // qui23(5) sex24(6) seg27(7). Contar o 20/11 aqui daria 28/11.
    expect(fmt(computeDueAt(d("2023-11-16"), 7))).toBe("2023-11-27");
  });

  it("três anos depois de 2030, ancorados na Páscoa da tabela do Census (#2413)", () => {
    // Páscoa: 2031-04-13, 2035-03-25, 2038-04-25 (tabela do US Census Bureau,
    // a mesma que o #2410 usou para Portugal). Os móveis saem dela.
    const ancorados: Array<[number, string, string, string, string]> = [
      [2031, "2031-02-24", "2031-02-25", "2031-04-11", "2031-06-12"],
      [2035, "2035-02-05", "2035-02-06", "2035-03-23", "2035-05-24"],
      [2038, "2038-03-08", "2038-03-09", "2038-04-23", "2038-06-24"],
    ];
    for (const [ano, segunda, terca, sextaSanta, corpoDeDeus] of ancorados) {
      // A lista que o prazo consome, não só a função: a #2413 era a LISTA parar em 2030.
      for (const dia of [`${ano}-01-01`, segunda, terca, sextaSanta, corpoDeDeus]) {
        expect(HOLIDAYS_BR_ISO).toContain(dia);
      }
      const feriados = feriadosDoBrasilDoAno(ano);
      expect(feriados).toContain(segunda);
      expect(feriados).toContain(terca);
      expect(feriados).toContain(sextaSanta);
      expect(feriados).toContain(corpoDeDeus);
    }
  });
});
