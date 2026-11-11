/**
 * A RÉGUA DA OPÇÃO (#3508), na função pura.
 *
 * O que este arquivo fixa, e por quê:
 *
 *  - `select` e `multiselect` — os dois tipos que existiam ANTES da lista
 *    pesquisável e que gravavam o texto cru — passam a casar o valor com a
 *    opção. É a régua que já existia (`validarValorPesquisavel`), estendida, e
 *    não uma paralela: os casos abaixo são os mesmos que a ficha já usa.
 *  - o que NÃO casa é RECUSADO dizendo qual item — quem grava decide se vira
 *    422 (API/MCP) ou texto cru (captação).
 *  - as bordas que protegem a base existente: vazio nunca recusa, campo sem
 *    opção passa direto, tipo que não guarda opção passa direto byte a byte.
 *  - a vírgula: separa ITENS na múltipla, mas não parte um rótulo que já a
 *    contém ("Rio de Janeiro, RJ").
 */
import { describe, expect, it } from "vitest";

import { canonizarCamposDoFunil, canonizarValorDoCampo } from "@/lib/leads/campos-pesquisaveis";

const ESTADOS = [
  { value: "sp", label: "São Paulo", aliases: ["SP", "Sampa"] },
  { value: "rj", label: "Rio de Janeiro, RJ" },
  { value: "mg", label: "Minas Gerais" },
];

const SELECT = { type: "select" as const, options: ESTADOS };
const MULTI = { type: "multiselect" as const, options: ESTADOS };
const PESQUISAVEL = { type: "searchable_select" as const, options: ESTADOS };

describe("canonizarValorDoCampo — select", () => {
  it("casa por rótulo sem caixa, acento nem espaço a mais e devolve o `value`", () => {
    expect(canonizarValorDoCampo(SELECT, "sao paulo")).toEqual({ ok: true, valor: "sp" });
    expect(canonizarValorDoCampo(SELECT, "  SÃO   PAULO ")).toEqual({ ok: true, valor: "sp" });
  });

  it("casa por apelido e pelo próprio `value`", () => {
    expect(canonizarValorDoCampo(SELECT, "Sampa")).toEqual({ ok: true, valor: "sp" });
    expect(canonizarValorDoCampo(SELECT, "MG")).toEqual({ ok: true, valor: "mg" });
  });

  it("não separa por vírgula: o rótulo inteiro é a opção", () => {
    expect(canonizarValorDoCampo(SELECT, "rio de janeiro, rj")).toEqual({ ok: true, valor: "rj" });
  });

  it("fora da lista: recusa e diz qual item não casou", () => {
    expect(canonizarValorDoCampo(SELECT, "Bahia")).toEqual({
      ok: false,
      motivo: "fora_da_lista",
      item: "Bahia",
    });
    // O item recusado sai APARADO: a mensagem não pode chegar com o espaço do
    // separador ("  Bahia") — é o achado da primeira versão do conserto.
    expect(canonizarValorDoCampo(SELECT, "  Bahia  ")).toMatchObject({ item: "Bahia" });
  });

  it("vazio nunca é recusado — limpar o campo é escrita válida", () => {
    expect(canonizarValorDoCampo(SELECT, "")).toEqual({ ok: true, valor: "" });
    expect(canonizarValorDoCampo(SELECT, "   ")).toEqual({ ok: true, valor: "   " });
    expect(canonizarValorDoCampo(SELECT, null)).toEqual({ ok: true, valor: null });
    expect(canonizarValorDoCampo(SELECT, undefined)).toEqual({ ok: true, valor: undefined });
  });

  it("campo sem opção cadastrada não tem contra o que conferir: passa direto", () => {
    expect(canonizarValorDoCampo({ type: "select" }, "qualquer")).toEqual({
      ok: true,
      valor: "qualquer",
    });
    expect(canonizarValorDoCampo({ type: "select", options: [] }, "qualquer")).toEqual({
      ok: true,
      valor: "qualquer",
    });
  });

  it("os tipos que NÃO guardam opção passam direto, byte a byte", () => {
    expect(canonizarValorDoCampo({ type: "text" }, "sao paulo")).toEqual({
      ok: true,
      valor: "sao paulo",
    });
    expect(canonizarValorDoCampo({ type: "number" }, 12)).toEqual({ ok: true, valor: 12 });
  });

  it("`allow_new` continua exclusivo da lista pesquisável: no `select` a lista é fechada", () => {
    //
    // O jsonb é dado do tenant e pode trazer a chave em qualquer tipo; num
    // `select` ela não abre nada. Sem esta asserção, ligar a válvula num campo
    // que a tela nem oferece criaria a sétima grafia pela porta de trás.
    const comValvula = { ...SELECT, allow_new: true };
    expect(canonizarValorDoCampo(comValvula, "Bahia")).toEqual({
      ok: false,
      motivo: "fora_da_lista",
      item: "Bahia",
    });
  });
});

describe("canonizarValorDoCampo — multiselect", () => {
  it("texto separado por vírgula vira a lista de `value`, sem repetição", () => {
    expect(canonizarValorDoCampo(MULTI, "minas gerais, sao paulo")).toEqual({
      ok: true,
      valor: ["mg", "sp"],
    });
    expect(canonizarValorDoCampo(MULTI, "São Paulo, sampa, SP")).toEqual({
      ok: true,
      valor: ["sp"],
    });
  });

  it("lista de verdade é julgada item a item", () => {
    expect(canonizarValorDoCampo(MULTI, ["minas gerais", "MG"])).toEqual({
      ok: true,
      valor: ["mg"],
    });
  });

  it("o texto INTEIRO já sendo uma opção, a vírgula do rótulo não separa", () => {
    expect(canonizarValorDoCampo(MULTI, "Rio de Janeiro, RJ")).toEqual({
      ok: true,
      valor: ["rj"],
    });
  });

  it("LIMITE declarado: rótulo COM vírgula mais um segundo item não se adivinha — recusa", () => {
    //
    // "Rio de Janeiro, RJ" é uma opção; "Rio de Janeiro, RJ, Minas Gerais" seria
    // essa opção mais outra. Separar por vírgula parte o rótulo ao meio, e juntar
    // por tentativa seria adivinhar o que a pessoa quis dizer. Recusar é o
    // desfecho honesto: na API/MCP o 422 pede a lista; na captação o texto entra
    // como veio. Quem manda vários itens escolhe rótulos sem vírgula.
    expect(canonizarValorDoCampo(MULTI, "rio de janeiro, rj, minas gerais")).toEqual({
      ok: false,
      motivo: "fora_da_lista",
      item: "rio de janeiro",
    });
  });

  it("um item fora da lista recusa a escrita INTEIRA (não grava metade)", () => {
    expect(canonizarValorDoCampo(MULTI, "minas gerais, Bahia")).toEqual({
      ok: false,
      motivo: "fora_da_lista",
      item: "Bahia",
    });
  });

  it("vazio é lista vazia; ausente continua ausente", () => {
    expect(canonizarValorDoCampo(MULTI, "")).toEqual({ ok: true, valor: [] });
    expect(canonizarValorDoCampo(MULTI, [])).toEqual({ ok: true, valor: [] });
    expect(canonizarValorDoCampo(MULTI, null)).toEqual({ ok: true, valor: null });
  });
});

describe("canonizarValorDoCampo — a lista pesquisável não muda (controle)", () => {
  it("valor único: o mesmo veredito de antes", () => {
    expect(canonizarValorDoCampo(PESQUISAVEL, "sao paulo")).toEqual({ ok: true, valor: "sp" });
    expect(canonizarValorDoCampo(PESQUISAVEL, "Bahia")).toEqual({
      ok: false,
      motivo: "fora_da_lista",
      item: "Bahia",
    });
  });

  it("com `allow_new`, o valor novo passa aparado", () => {
    expect(canonizarValorDoCampo({ ...PESQUISAVEL, allow_new: true }, "  Bahia  ")).toEqual({
      ok: true,
      valor: "Bahia",
    });
  });

  it("com `multiple`, a lista é de canônicos", () => {
    expect(canonizarValorDoCampo({ ...PESQUISAVEL, multiple: true }, "sao paulo,minas gerais")).toEqual({
      ok: true,
      valor: ["sp", "mg"],
    });
  });
});

describe("canonizarCamposDoFunil — o recorte que o servidor aplica", () => {
  const DEFS = [
    { key: "estado", type: "select" as const, options: ESTADOS },
    { key: "interesses", type: "multiselect" as const, options: ESTADOS },
    { key: "observacao", type: "text" as const },
  ];

  it("devolve SÓ o que muda, e o que não tem definição nem é olhado", () => {
    const { mudados, recusas } = canonizarCamposDoFunil(DEFS, {
      estado: "sao paulo",
      interesses: "minas gerais, sao paulo",
      observacao: "texto livre",
      campo_que_o_funil_nao_declara: "qualquer coisa",
    });

    expect(recusas).toEqual([]);
    expect(mudados).toEqual({ estado: "sp", interesses: ["mg", "sp"] });
  });

  it("valor que já é o `value` não entra em `mudados` (nada a reescrever)", () => {
    const { mudados } = canonizarCamposDoFunil(DEFS, { estado: "sp" });
    expect(mudados).toEqual({});
  });

  it("as recusas dizem campo, motivo e item — e não entram em `mudados`", () => {
    const { mudados, recusas } = canonizarCamposDoFunil(DEFS, {
      estado: "Bahia",
      interesses: "MG",
    });

    expect(recusas).toEqual([{ campo: "estado", motivo: "fora_da_lista", valor: "Bahia" }]);
    expect(mudados).toEqual({ interesses: ["mg"] });
  });
});
