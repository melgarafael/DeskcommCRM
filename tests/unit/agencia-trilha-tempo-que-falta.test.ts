import { describe, expect, it } from "vitest";

import { tempoQueFalta } from "@/lib/agencia/trilhas/tempo-que-falta";

const agora = new Date("2026-10-27T12:00:00Z");
const mais = (ms: number) => new Date(agora.getTime() + ms).toISOString();
const H = 3600_000;

describe("reloginho da trilha", () => {
  it("com folga mostra dias e horas", () => {
    expect(tempoQueFalta(mais(2 * 24 * H + 4 * H + 30 * 60_000), agora)).toEqual({ texto: "faltam 2 d 4 h", nivel: "folga" });
  });

  it("a menos de 24 h fica perto e conta os segundos", () => {
    expect(tempoQueFalta(mais(5 * H + 7 * 60_000), agora)).toEqual({ texto: "faltam 5 h 07 min 00 s", nivel: "perto" });
    expect(tempoQueFalta(mais(12 * 60_000 + 5_000), agora)).toEqual({ texto: "faltam 12 min 05 s", nivel: "perto" });
  });

  it("vencido conta o atraso", () => {
    expect(tempoQueFalta(mais(-3 * H), agora)).toEqual({ texto: "atrasado há 3 h 00 min 00 s", nivel: "atrasado" });
    expect(tempoQueFalta(agora.toISOString(), agora).nivel).toBe("atrasado");
    expect(tempoQueFalta(mais(-26 * H), agora).texto).toBe("atrasado há 1 d 2 h");
  });
});
