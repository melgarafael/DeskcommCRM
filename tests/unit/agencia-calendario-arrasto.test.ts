import { describe, expect, it } from "vitest";

import { horarioDepoisDoGesto, minutosDoArrasto } from "@/lib/agencia/calendario/arrasto";
import { horaLocal, instanteDoDia } from "@/lib/agencia/calendario/regras";

const em = (dia: string, hora: string) => instanteDoDia(dia, hora).toISOString();
const horas = (r: { inicio: string; fim: string } | null) => (r ? `${horaLocal(r.inicio)}-${horaLocal(r.fim)}` : null);
const base = { inicio: em("2026-11-10", "10:00"), fim: em("2026-11-10", "11:00") };

describe("arrastar e esticar no calendário", () => {
  it("pixels viram minutos, de 15 em 15", () => {
    expect(minutosDoArrasto(48, 48)).toBe(60);
    expect(minutosDoArrasto(13, 48)).toBe(15);
    expect(minutosDoArrasto(5, 48)).toBe(0);
    expect(minutosDoArrasto(-25, 48)).toBe(-30);
  });

  it("mover desloca início e fim juntos, e pode trocar de dia", () => {
    expect(horas(horarioDepoisDoGesto({ ...base, modo: "mover", deltaMin: 90 }))).toBe("11:30-12:30");
    const outroDia = horarioDepoisDoGesto({ ...base, modo: "mover", deltaMin: 0, diaNovo: "2026-11-12" });
    expect(outroDia?.inicio).toBe(em("2026-11-12", "10:00"));
    expect(horas(outroDia)).toBe("10:00-11:00");
  });

  it("mover não sai da faixa das 7h às 22h", () => {
    expect(horas(horarioDepoisDoGesto({ ...base, modo: "mover", deltaMin: -600 }))).toBe("07:00-08:00");
    expect(horas(horarioDepoisDoGesto({ ...base, modo: "mover", deltaMin: 900 }))).toBe("21:00-22:00");
  });

  it("esticar muda só o fim, com no mínimo 15 minutos e até as 22h", () => {
    expect(horas(horarioDepoisDoGesto({ ...base, modo: "esticar", deltaMin: 30 }))).toBe("10:00-11:30");
    expect(horas(horarioDepoisDoGesto({ ...base, modo: "esticar", deltaMin: -120 }))).toBe("10:00-10:15");
    expect(horas(horarioDepoisDoGesto({ ...base, modo: "esticar", deltaMin: 1000 }))).toBe("10:00-22:00");
  });

  it("sem mudança devolve null (não remarca à toa)", () => {
    expect(horarioDepoisDoGesto({ ...base, modo: "mover", deltaMin: 0 })).toBeNull();
    expect(horarioDepoisDoGesto({ ...base, modo: "mover", deltaMin: 0, diaNovo: "2026-11-10" })).toBeNull();
  });
});
