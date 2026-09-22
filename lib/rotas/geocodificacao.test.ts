import { describe, expect, it } from "vitest";

import {
  expandirAbreviacoes,
  limparComplemento,
  montarConsultas,
  normalizarNumero,
  parseLinhaEndereco,
  ruaSemNumeroColado,
  semTipoVial,
} from "./geocodificacao";

describe("normalização da consulta", () => {
  it("número com texto vira dígitos; SN/KM viram nada", () => {
    expect(normalizarNumero("268 sala03")).toBe("268");
    expect(normalizarNumero("65")).toBe("65");
    expect(normalizarNumero("SN")).toBeNull();
    expect(normalizarNumero("S/N")).toBeNull();
    expect(normalizarNumero("KM 258")).toBeNull();
    expect(normalizarNumero(null)).toBeNull();
  });

  it("expande abreviatura sem comer palavra", () => {
    expect(expandirAbreviacoes("R CEL ALBUQUERQUE")).toBe("Rua Coronel ALBUQUERQUE");
    expect(expandirAbreviacoes("RUA DUQUE DE CAXIAS")).toBe("RUA DUQUE DE CAXIAS");
    expect(expandirAbreviacoes("AV. MIGUEL KOMARCHEWSKI")).toBe("Avenida MIGUEL KOMARCHEWSKI");
    expect(expandirAbreviacoes("AV.GOV.Jorge Lacerda")).toBe("Avenida Governador Jorge Lacerda");
    expect(expandirAbreviacoes("RUA MAL FLORIANO PEIXOTO")).toBe("RUA Marechal FLORIANO PEIXOTO");
  });

  it("complemento sai, endereço fica", () => {
    expect(limparComplemento("268 sala03")).toBe("268");
    expect(limparComplemento("LOJA")).toBe("");
    expect(limparComplemento("RUA X, 10 FUNDOS")).toBe("RUA X, 10");
    expect(limparComplemento("CENTRO")).toBe("CENTRO");
    expect(limparComplemento("CORONEL ALBUQUERQUE, 268 sala03, ATÉ 599/600")).toBe(
      "CORONEL ALBUQUERQUE, 268",
    );
    expect(limparComplemento("R VIDAL RAMOS, 1195, SALA PISO SUPERIOR")).toBe("Rua VIDAL RAMOS, 1195");
    expect(limparComplemento("Avenida dos expedicionários, 1259, antiga panif arco iris")).toBe(
      "Avenida dos expedicionários, 1259",
    );
    expect(limparComplemento("R CAETANO COSTA, 739, SALA 01")).toBe("Rua CAETANO COSTA, 739");
    expect(limparComplemento("AV DOS EXPEDICIONARIOS, 3075, CXPST 91")).toBe(
      "Avenida DOS EXPEDICIONARIOS, 3075",
    );
    expect(limparComplemento("ROD. ANTONIO HEIL, n.177, SALA 116")).toBe("Rodovia ANTONIO HEIL, 177");
  });

  it("número colado no logradouro não duplica", () => {
    expect(ruaSemNumeroColado("RUA OROCIMBO CAETANO DA SILVA, 65", "65")).toBe(
      "RUA OROCIMBO CAETANO DA SILVA",
    );
    expect(ruaSemNumeroColado("RUA X", "10")).toBe("RUA X");
  });

  it("cadeia: exata → sem número (sem repetição)", () => {
    const q = montarConsultas({
      logradouro: "R CEL ALBUQUERQUE",
      numero_end: "268 sala03",
      bairro: "LOJA",
      cidade: "Canoinhas",
      uf: "SC",
    });
    // A rua já sai expandida (limparComplemento expande antes).
    expect(q[0]).toBe("Rua Coronel ALBUQUERQUE, 268, Canoinhas, SC, Brasil");
    expect(q).toContain("Rua Coronel ALBUQUERQUE, Canoinhas, SC, Brasil");
    // "LOJA" não entra em nenhuma fase.
    expect(q.every((x) => !x.includes("LOJA"))).toBe(true);
    expect(new Set(q).size).toBe(q.length);
  });

  it("últimas fases: primeiro trecho e sem UF", () => {
    const q = montarConsultas({
      logradouro: "br 280, 6372, systen som",
      numero_end: "6372",
      bairro: null,
      cidade: "Canoinhas",
      uf: "SC",
    });
    expect(q).toContain("br 280, Canoinhas, SC, Brasil");
    expect(q[q.length - 1]).toBe("br 280, Canoinhas, Brasil");
  });

  it("letra solta sai, Rua fica", () => {
    expect(limparComplemento("CAMPOS S SALES")).toBe("CAMPOS SALES");
    expect(limparComplemento("R CEL ALBUQUERQUE")).toBe("Rua Coronel ALBUQUERQUE");
    expect(limparComplemento("RUBENS RIBEIRO DA SILVA, 329, LADO ÍMPAR")).toBe(
      "RUBENS RIBEIRO DA SILVA, 329",
    );
    expect(limparComplemento("JOAO CANDIDO FERREIRA 505 NULL")).toBe("JOAO CANDIDO FERREIRA 505");
    expect(limparComplemento("RUBENS RIBEIRO DA SILVA, 837, ***")).toBe("RUBENS RIBEIRO DA SILVA, 837");
  });

  it("tipo trocado no cadastro: tenta sem tipo (com número)", () => {
    expect(semTipoVial("Avenida Rubens Ribeiro da Silva")).toBe("Rubens Ribeiro da Silva");
    expect(semTipoVial("Rua Caetano Costa")).toBe("Caetano Costa");
    expect(semTipoVial("BR 280")).toBe("BR 280");
    const q = montarConsultas({
      logradouro: "AV RUBENS RIBEIRO DA SILVA, 85, SALA 03",
      numero_end: null,
      bairro: "Campo da Água Verde",
      cidade: "Canoinhas",
      uf: "SC",
    });
    expect(q).toContain("RUBENS RIBEIRO DA SILVA, 85, Campo da Água Verde, Canoinhas, SC, Brasil");
  });

  it("sem rua ou sem cidade não consulta", () => {
    expect(montarConsultas({ logradouro: null, cidade: "Canoinhas", uf: "SC" })).toEqual([]);
    expect(montarConsultas({ logradouro: "RUA X", cidade: null, uf: "SC" })).toEqual([]);
  });

  it("faixa DE..A sem lado também é resto de cadastro", () => {
    expect(limparComplemento("BARÃO DO RIO BRANCO, 771, DE 120/121 A 899/900")).toBe(
      "BARÃO DO RIO BRANCO, 771",
    );
    expect(limparComplemento("RUA DOS EXPEDICIONARIOS")).toBe("RUA DOS EXPEDICIONARIOS");
  });

  it("linha do pedido vira partes (avulso também tem cadeia)", () => {
    expect(parseLinhaEndereco("RUA X, 65 — BAIRRO, CIDADE/UF, 89520000")).toEqual({
      logradouro: "RUA X, 65",
      numero_end: null,
      bairro: "BAIRRO",
      cidade: "CIDADE",
      uf: "UF",
    });
    expect(parseLinhaEndereco("RUA X, 65")).toEqual({
      logradouro: "RUA X, 65",
      numero_end: null,
      bairro: null,
      cidade: null,
      uf: null,
    });
  });
});
