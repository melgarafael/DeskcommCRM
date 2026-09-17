/**
 * Quem decide se alguém recebe um parabéns é `diasDeAniversarioAgora`, e ela é
 * pura de propósito: as três coisas que ela acerta (o fuso, a hora e o 29 de
 * fevereiro) são caras ou impossíveis de exercitar contra o banco.
 *
 * O 29 de fevereiro é o caso que justifica o arquivo sozinho: sem ele, esperar
 * o defeito aparecer custa quatro anos.
 */
import { describe, expect, it } from "vitest";

import { diasDeAniversarioAgora, HORA_DE_PARABENIZAR } from "./route";

/** 12:00 UTC é 09:00 em São Paulo (UTC-3), a hora de parabenizar. */
const AS_NOVE_EM_SP = new Date("2026-09-14T12:00:00.000Z");

describe("diasDeAniversarioAgora", () => {
  it("na hora marcada, devolve o dia local", () => {
    expect(diasDeAniversarioAgora(AS_NOVE_EM_SP, "America/Sao_Paulo")).toEqual([914]);
  });

  it("fora da hora marcada não devolve nada — é o que faz a varredura horária agir uma vez", () => {
    const umaHoraDepois = new Date("2026-09-14T13:00:00.000Z");
    expect(diasDeAniversarioAgora(umaHoraDepois, "America/Sao_Paulo")).toEqual([]);
  });

  it("o MESMO instante age em um fuso e não em outro", () => {
    // É a regra inteira em uma asserção: às 09:00 de São Paulo são 14:00 em
    // Lisboa, e lá ninguém é parabenizado ainda.
    expect(diasDeAniversarioAgora(AS_NOVE_EM_SP, "America/Sao_Paulo")).toEqual([914]);
    expect(diasDeAniversarioAgora(AS_NOVE_EM_SP, "Europe/Lisbon")).toEqual([]);
  });

  it("o dia é o LOCAL, não o do UTC", () => {
    // 03:00 UTC do dia 15 ainda é dia 14 em São Paulo, e é lá que são 00:00...
    // às 12:00 UTC do dia 15 é dia 15 às 09:00. O que importa é que a virada do
    // dia siga o relógio da organização, nunca o do servidor.
    const as9Do15 = new Date("2026-09-15T12:00:00.000Z");
    expect(diasDeAniversarioAgora(as9Do15, "America/Sao_Paulo")).toEqual([915]);
  });

  it("em ano NÃO bissexto, 28 de fevereiro responde também pelo 29", () => {
    // 2027 não é bissexto: quem nasceu em 29/02 não seria parabenizado nunca.
    const as9De28Fev2027 = new Date("2027-02-28T12:00:00.000Z");
    expect(diasDeAniversarioAgora(as9De28Fev2027, "America/Sao_Paulo")).toEqual([228, 229]);
  });

  it("em ano bissexto, 28 de fevereiro é só o 28 — e o 29 é o 29", () => {
    // 2028 é bissexto: quem nasceu em 29/02 tem o dia dele, e antecipar seria
    // parabenizar duas vezes.
    const as9De28Fev2028 = new Date("2028-02-28T12:00:00.000Z");
    expect(diasDeAniversarioAgora(as9De28Fev2028, "America/Sao_Paulo")).toEqual([228]);

    const as9De29Fev2028 = new Date("2028-02-29T12:00:00.000Z");
    expect(diasDeAniversarioAgora(as9De29Fev2028, "America/Sao_Paulo")).toEqual([229]);
  });

  it("2100 não é bissexto, apesar de divisível por 4", () => {
    // A regra do século: divisível por 100 e não por 400. Um `% 4 === 0` solto
    // passaria em todo o resto da suíte e erraria aqui.
    const as9De28Fev2100 = new Date("2100-02-28T12:00:00.000Z");
    expect(diasDeAniversarioAgora(as9De28Fev2100, "America/Sao_Paulo")).toEqual([228, 229]);
  });

  it("2000 é bissexto, porque é divisível por 400", () => {
    const as9De28Fev2000 = new Date("2000-02-28T12:00:00.000Z");
    expect(diasDeAniversarioAgora(as9De28Fev2000, "America/Sao_Paulo")).toEqual([228]);
  });

  it("a hora é a declarada, e não um literal escondido na função", () => {
    expect(HORA_DE_PARABENIZAR).toBe(9);
  });
});
