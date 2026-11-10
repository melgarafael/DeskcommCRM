// @vitest-environment node
import { describe, expect, it } from "vitest";
import { horarioLivreDaBancada } from "./semear-jornadas";

const preferido = "2026-10-28T20:00:00.000Z"; // 17h em São Paulo.
const intervalo = (starts_at: string, ends_at: string) => ({ starts_at, ends_at });

describe("horário fictício das histórias sem tocar na agenda alheia", () => {
  it("usa a preferência livre, inclusive quando encosta no fim ou início de outro compromisso", () => {
    const ocupados = [
      intervalo("2026-10-28T19:30:00.000Z", preferido),
      intervalo("2026-10-28T20:30:00.000Z", "2026-10-28T21:00:00.000Z"),
    ];
    expect(horarioLivreDaBancada(preferido, ocupados)).toBe(preferido);
  });

  it("desvia de intervalos sobrepostos e mantém a duração de meia hora", () => {
    const ocupados = [
      intervalo("2026-10-28T20:15:00.000Z", "2026-10-28T20:45:00.000Z"),
      intervalo(preferido, "2026-10-28T20:30:00.000Z"),
    ];
    const antes = structuredClone(ocupados);
    expect(horarioLivreDaBancada(preferido, ocupados)).toBe("2026-10-28T21:00:00.000Z");
    expect(ocupados).toEqual(antes);
  });

  it("reutiliza a escolha própria entre cenas mesmo se a preferência original ficar livre", () => {
    const proprio = intervalo("2026-10-28T20:30:00.000Z", "2026-10-28T21:00:00.000Z");
    expect(horarioLivreDaBancada(preferido, [], proprio)).toBe(proprio.starts_at);
  });

  it("respeita o novo dia da remarcação e conserva essa escolha ao repetir a cena", () => {
    const antigo = intervalo(preferido, "2026-10-28T20:30:00.000Z");
    const novoDia = "2026-10-29T20:00:00.000Z";
    const ocupado = intervalo(novoDia, "2026-10-29T20:30:00.000Z");
    const escolhido = horarioLivreDaBancada(novoDia, [ocupado], antigo);
    expect(escolhido).toBe("2026-10-29T20:30:00.000Z");
    expect(
      horarioLivreDaBancada(novoDia, [], intervalo(escolhido, "2026-10-29T21:00:00.000Z")),
    ).toBe(escolhido);
  });

  it("não troca de dia silenciosamente quando a bancada está ocupada até meia-noite local", () => {
    expect(() =>
      horarioLivreDaBancada(preferido, [intervalo(preferido, "2026-10-29T03:00:00.000Z")]),
    ).toThrow("dia escolhido");
  });

  it("mantém a cena pendente se outra reserva passar a ocupar o horário já escolhido", () => {
    const proprio = intervalo(preferido, "2026-10-28T20:30:00.000Z");
    expect(() => horarioLivreDaBancada(preferido, [proprio], proprio)).toThrow("horário próprio");
  });
});
