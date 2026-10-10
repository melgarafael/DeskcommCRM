import { describe, expect, it } from "vitest";

import { documentoDoPagador, exigeDocumento, isValidCnpj, sugestaoDoCadastro } from "./documento";

// Os exemplos canônicos da Receita (sem dono real), montados por partes.
const CNPJ = ["11", "222", "333", "0001", "81"].join("");
const CPF = ["529", "982", "247", "25"].join("");

describe("documento de quem paga (CPF/CNPJ)", () => {
  it.each([
    ["529.982.247-25", CPF],
    [CPF, CPF],
    ["11.222.333/0001-81", CNPJ],
    [CNPJ, CNPJ],
    [" 11 222 333 0001 81 ", CNPJ],
  ])("%j → %s (máscara e espaço saem; o número fica)", (bruto, esperado) => {
    expect(documentoDoPagador(bruto)).toBe(esperado);
  });

  it("⭐ CNPJ alfanumérico da Receita: aceito e normalizado em maiúsculas", () => {
    expect(documentoDoPagador("12.ABC.345/01DE-35")).toBe("12ABC34501DE35");
    expect(documentoDoPagador("12abc34501de35")).toBe("12ABC34501DE35");
  });

  it.each([
    [CPF.slice(0, 10) + "4"],
    ["111.111.111-11"],
    [CNPJ.slice(0, 13) + "2"],
    ["00.000.000/0000-00"],
    ["12ABC34501DE36"],
    ["12ABC34501DEX5"],
    [CPF.slice(0, 10)],
    [CPF + "5"],
    [CNPJ + "1"],
    [CPF.slice(0, 10) + "A"],
    [""],
  ])("%j é recusado", (bruto) => {
    expect(documentoDoPagador(bruto)).toBeNull();
  });

  it("isValidCnpj confere os dois dígitos (pesos 5..2,9..2 e 6..2,9..2; letra vale código − 48)", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("12ABC34501DE35")).toBe(true);
    expect(isValidCnpj("11.222.333/0001-80")).toBe(false);
  });

  it("⭐ só o Asaas pede, e só quando o checkout vai CRIAR o cliente lá (reassinar não pede de novo)", () => {
    expect(exigeDocumento("asaas", false)).toBe(true);
    expect(exigeDocumento("asaas", true)).toBe(false);
    expect(exigeDocumento("stripe", false)).toBe(false);
    expect(exigeDocumento(null, false)).toBe(false);
  });

  it("o CNPJ do cadastro vira sugestão só com os dígitos certos, já sem máscara", () => {
    expect(sugestaoDoCadastro("11.222.333/0001-81")).toBe(CNPJ);
    expect(sugestaoDoCadastro("11.222.333/0001-82")).toBeNull();
    expect(sugestaoDoCadastro(null)).toBeNull();
  });
});
