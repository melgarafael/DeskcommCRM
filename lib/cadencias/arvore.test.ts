import { describe, expect, it } from "vitest";

import {
  duplicarPasso,
  encontrarPasso,
  haEmailAntes,
  inserirPasso,
  numerarPassos,
  passoVazio,
  removerPasso,
  validarPassos,
} from "./arvore";
import { cadenciaDeExemplo } from "./exemplos";
import type { Passo } from "./tipos";

const email = (id: string): Passo => ({ id, tipo: "email", assunto: "a", corpo: "b", mesmaConversa: false });
const espera = (id: string): Passo => ({ id, tipo: "espera", diasUteis: 2 });

describe("árvore da cadência", () => {
  it("insere na posição pedida da lista principal", () => {
    const out = inserirPasso([email("1"), email("3")], { lista: "raiz", indice: 1 }, espera("2"));
    expect(out.map((p) => p.id)).toEqual(["1", "2", "3"]);
  });

  it("ramo no meio da sequência leva o que vinha depois para o lado 'não'", () => {
    const ramo = { ...passoVazio("ramo"), id: "r" };
    const out = inserirPasso([email("1"), espera("2"), email("3")], { lista: "raiz", indice: 1 }, ramo);
    expect(out.map((p) => p.id)).toEqual(["1", "r"]);
    const r = out[1];
    expect(r?.tipo === "ramo" && r.nao.map((p) => p.id)).toEqual(["2", "3"]);
    expect(r?.tipo === "ramo" && r.sim).toEqual([]);
  });

  it("insere, remove e duplica dentro de um ramo sem mexer no resto", () => {
    const base = cadenciaDeExemplo().passos;
    const comNovo = inserirPasso(base, { lista: "ex-3:sim", indice: 0 }, espera("novo"));
    expect(encontrarPasso(comNovo, "novo")).not.toBeNull();
    expect(removerPasso(comNovo, "novo")).toEqual(base);

    const dup = duplicarPasso(base, "ex-6");
    const ramo = dup[2];
    expect(ramo?.tipo === "ramo" && ramo.nao.length).toBe(4);
    expect(ramo?.tipo === "ramo" && ramo.nao[1]?.id).not.toBe("ex-6");
    // Entrada intacta: as operações são puras.
    expect(base[2]?.tipo === "ramo" && base[2].nao.length).toBe(3);
  });

  it("numera na ordem de leitura, 'sim' antes de 'não'", () => {
    const n = numerarPassos(cadenciaDeExemplo().passos);
    expect([...n.entries()].map(([id, i]) => `${i}:${id}`)).toEqual([
      "1:ex-1", "2:ex-2", "3:ex-3", "4:ex-4", "5:ex-5", "6:ex-6", "7:ex-7", "8:ex-8",
    ]);
  });

  it("'mesma conversa' só existe depois de um e-mail no mesmo caminho", () => {
    const passos = cadenciaDeExemplo().passos;
    expect(haEmailAntes(passos, "ex-1")).toBe(false);
    expect(haEmailAntes(passos, "ex-6")).toBe(true);
    expect(haEmailAntes([espera("a"), email("b")], "b")).toBe(false);
  });

  it("valida o que impede ativar", () => {
    const vazio = passoVazio("email");
    const erros = validarPassos([vazio, { ...passoVazio("ramo"), id: "r" }]);
    expect(erros.get(vazio.id)).toEqual(["Informe o assunto do e-mail.", "Escreva o corpo do e-mail."]);
    expect(erros.get("r")).toEqual(["O ramo precisa de pelo menos um passo em um dos lados."]);
    expect(validarPassos(cadenciaDeExemplo().passos).size).toBe(0);
  });
});
