import { describe, expect, it } from "vitest";
import {
  normalizaPatamaresDeTarefa,
  patamarDaEspera,
  processarLembretesTarefa,
} from "./lembretes-tarefa";
import type { SupabaseClient } from "@supabase/supabase-js";

const inicio = "2026-10-04T12:00:00Z";
const apos = (ms: number) => new Date(Date.parse(inicio) + ms);

describe("relógio absoluto da tarefa", () => {
  it.each([
    [179_999, null],
    [180_000, 3],
    [359_999, 3],
    [360_000, 6],
    [539_999, 6],
    [540_000, 9],
    [600_000, 9],
  ] as const)("%i ms → %s", (ms, esperado) => {
    expect(patamarDaEspera(inicio, apos(ms))).toBe(esperado);
  });
  it("não cobra espera futura ou inválida", () => {
    expect(patamarDaEspera(inicio, apos(-1))).toBeNull();
    expect(patamarDaEspera("inválido", apos(0))).toBeNull();
  });
  it("usa cadência configurada e devolve apenas o último marco devido", () => {
    const cadencia = [2, 5, 12];
    expect(patamarDaEspera(inicio, apos(119_999), cadencia)).toBeNull();
    expect(patamarDaEspera(inicio, apos(120_000), cadencia)).toBe(2);
    expect(patamarDaEspera(inicio, apos(12 * 60_000), cadencia)).toBe(12);
    expect(patamarDaEspera(inicio, apos(60 * 60_000), cadencia)).toBe(12);
  });
  it("valida a cadência salva sem ordenar ou corrigir silenciosamente", () => {
    expect(normalizaPatamaresDeTarefa(undefined)).toEqual([3, 6, 9]);
    expect(normalizaPatamaresDeTarefa([2, 5, 12])).toEqual([2, 5, 12]);
    expect(normalizaPatamaresDeTarefa([2, 2])).toEqual([]);
    expect(normalizaPatamaresDeTarefa([5, 2])).toEqual([]);
    expect(normalizaPatamaresDeTarefa([0, 5])).toEqual([]);
    expect(normalizaPatamaresDeTarefa([1441])).toEqual([]);
    expect(normalizaPatamaresDeTarefa(Array.from({ length: 11 }, (_, i) => i + 1))).toEqual([]);
  });
  it("propaga falha do claim atômico, sem declarar sucesso", async () => {
    const admin = {
      rpc: async () => ({ data: null, error: { message: "banco indisponível" } }),
    } as unknown as SupabaseClient;
    await expect(processarLembretesTarefa(admin)).rejects.toThrow("banco indisponível");
  });
});
