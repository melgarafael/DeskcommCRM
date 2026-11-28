/**
 * O CAMPO DE LISTA ACEITA NÚMERO E BOOLEANO QUE CASAM COM A OPÇÃO (#5328).
 *
 * O defeito, em produção: o agente manda `{ adultos: 4, tem_criancas: true }` e
 * a régua recusa com `valor "4"` — um valor que ESTÁ na lista. A causa é o
 * `valorDeUmItem`, que mandava para `fora_da_lista` todo item que não fosse
 * `string`, sem tentar a forma textual.
 *
 * O que este arquivo fixa:
 *
 *  - número que casa vira o texto da opção (`4` → `"4"`), inclusive `0`, que é
 *    falsy em JS e opção legítima;
 *  - número que NÃO casa continua recusado — e a recusa diz que veio número;
 *  - booleano vira `Sim`/`Não` quando o campo declara essas opções;
 *  - booleano em campo SEM Sim/Não continua recusado (não vira `"true"`);
 *  - string fora da lista continua recusada, com o contrato de antes.
 */
import { describe, expect, it } from "vitest";

import { canonizarCamposDoFunil } from "@/lib/leads/campos-pesquisaveis";
import { erroForaDaLista } from "@/lib/leads/opcao-do-campo-no-servidor";

/** `adultos`: "0"…"9" e "10 ou mais", como o funil da Dom Travel. */
const ADULTOS = {
  key: "adultos",
  type: "select" as const,
  options: [
    ...Array.from({ length: 10 }, (_, n) => ({ value: String(n), label: String(n) })),
    { value: "10", label: "10 ou mais" },
  ],
};

const TEM_CRIANCAS = {
  key: "tem_criancas",
  type: "select" as const,
  options: [
    { value: "sim", label: "Sim" },
    { value: "nao", label: "Não" },
  ],
};

describe("campo de lista com número e booleano (#5328)", () => {
  it("número que casa vira o texto da opção, inclusive o 0 falsy", () => {
    const r = canonizarCamposDoFunil([ADULTOS], { adultos: 4 });
    expect(r.recusas).toEqual([]);
    expect(r.mudados).toEqual({ adultos: "4" });

    const zero = canonizarCamposDoFunil([ADULTOS], { adultos: 0 });
    expect(zero.recusas).toEqual([]);
    expect(zero.mudados).toEqual({ adultos: "0" });
  });

  it("número que NÃO casa continua recusado, e a recusa diz que veio número", () => {
    const r = canonizarCamposDoFunil([ADULTOS], { adultos: 12 });
    expect(r.mudados).toEqual({});
    expect(r.recusas).toEqual([
      { campo: "adultos", motivo: "fora_da_lista", valor: "12", tipoRecebido: "numero" },
    ]);

    const mensagem = erroForaDaLista(r.recusas, "req-1").message;
    expect(mensagem).toContain('Campo "adultos", valor "12"');
    expect(mensagem).toContain("veio como número");

    // Casa decimal não é opção nenhuma: converte, não casa, recusa.
    const decimal = canonizarCamposDoFunil([ADULTOS], { adultos: 4.5 });
    expect(decimal.recusas).toEqual([
      { campo: "adultos", motivo: "fora_da_lista", valor: "4.5", tipoRecebido: "numero" },
    ]);
  });

  it("booleano vira Sim/Não quando o campo tem essas opções", () => {
    const sim = canonizarCamposDoFunil([TEM_CRIANCAS], { tem_criancas: true });
    expect(sim.recusas).toEqual([]);
    expect(sim.mudados).toEqual({ tem_criancas: "sim" });

    const nao = canonizarCamposDoFunil([TEM_CRIANCAS], { tem_criancas: false });
    expect(nao.recusas).toEqual([]);
    expect(nao.mudados).toEqual({ tem_criancas: "nao" });
  });

  it("booleano em campo SEM Sim/Não continua recusado — não vira \"true\"", () => {
    const r = canonizarCamposDoFunil([ADULTOS], { adultos: true });
    expect(r.mudados).toEqual({});
    expect(r.recusas).toEqual([
      { campo: "adultos", motivo: "fora_da_lista", valor: "true", tipoRecebido: "booleano" },
    ]);
    expect(erroForaDaLista(r.recusas, "req-2").message).toContain("veio como booleano");
  });

  it("string fora da lista continua recusada, sem a frase de tipo", () => {
    const r = canonizarCamposDoFunil([ADULTOS], { adultos: "onze" });
    expect(r.mudados).toEqual({});
    // O contrato de antes: sem `tipoRecebido`, o objeto é exatamente o de sempre.
    expect(r.recusas).toEqual([{ campo: "adultos", motivo: "fora_da_lista", valor: "onze" }]);

    const mensagem = erroForaDaLista(r.recusas, "req-3").message;
    expect(mensagem).toContain('Campo "adultos", valor "onze"');
    expect(mensagem).not.toContain("veio como");
  });
});
