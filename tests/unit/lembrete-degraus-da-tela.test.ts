/**
 * O campo de degraus extras é texto livre, e o que sai dele vira mensagem no
 * WhatsApp de um cliente. Então ele tem teste.
 *
 * A recusa COM NOME (faixa, quantidade) é da rota, não daqui — esta função só
 * limpa pontuação de quem digitou "180," ou "180; 60". O que ela não pode fazer
 * é inventar degrau: qualquer coisa que não seja inteiro positivo some, em vez
 * de virar `NaN` a caminho do banco.
 */
import { describe, expect, it } from "vitest";

import { lerDegrausExtras } from "@/app/app/settings/tenant/agenda/_client";

describe("lerDegrausExtras", () => {
  it("vazio é vazio — quem não quer aviso extra não ganha nenhum", () => {
    expect(lerDegrausExtras("")).toEqual([]);
    expect(lerDegrausExtras(null)).toEqual([]);
  });

  it("lê um só", () => {
    expect(lerDegrausExtras("180")).toEqual([180]);
  });

  it("lê vários e ordena do mais antecipado ao mais próximo", () => {
    expect(lerDegrausExtras("60, 180")).toEqual([180, 60]);
  });

  it("aguenta a pontuação de quem copiou de outro lugar", () => {
    expect(lerDegrausExtras(" 180 ; 60 , ")).toEqual([180, 60]);
  });

  it("duplicata não vira aviso em dobro", () => {
    expect(lerDegrausExtras("180, 180")).toEqual([180]);
  });

  it("o que não é inteiro positivo some, e não vira NaN no banco", () => {
    expect(lerDegrausExtras("abc, 180, -5, 0, 1.5")).toEqual([180]);
  });
});
