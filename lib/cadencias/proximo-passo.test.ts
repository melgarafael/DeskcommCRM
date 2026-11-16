import { describe, expect, it } from "vitest";

import { primeiroDoLado, proximoIrmao } from "./proximo-passo";
import type { Passo } from "./tipos";

const email = (id: string): Passo => ({ id, tipo: "email", assunto: "a", corpo: "b", mesmaConversa: false });
const espera = (id: string): Passo => ({ id, tipo: "espera", diasUteis: 2 });
const ramo = (id: string, sim: Passo[], nao: Passo[]): Passo => ({
  id,
  tipo: "ramo",
  condicao: { tipo: "abriu", vezes: 1, dentroDeDias: 3 },
  sim,
  nao,
});

describe("proximoIrmao", () => {
  it("acha o próximo na raiz", () => {
    const passos = [email("e1"), espera("s1"), email("e2")];
    expect(proximoIrmao(passos, "e1")?.id).toBe("s1");
    expect(proximoIrmao(passos, "s1")?.id).toBe("e2");
  });

  it("fim da raiz devolve null", () => {
    const passos = [email("e1")];
    expect(proximoIrmao(passos, "e1")).toBeNull();
  });

  it("acha o próximo DENTRO do lado sim de um ramo", () => {
    const passos = [ramo("r1", [email("sim1"), email("sim2")], [email("nao1")])];
    expect(proximoIrmao(passos, "sim1")?.id).toBe("sim2");
  });

  it("fim do lado sim NÃO cai no lado não — conclui (null)", () => {
    const passos = [ramo("r1", [email("sim1")], [email("nao1")])];
    expect(proximoIrmao(passos, "sim1")).toBeNull();
  });

  it("acha o próximo dentro de um ramo aninhado", () => {
    const interno = ramo("r2", [email("aninhado")], []);
    const passos = [ramo("r1", [interno], [])];
    expect(proximoIrmao(passos, "aninhado")).toBeNull();
  });

  it("id que não existe na árvore devolve undefined→null pelo chamador", () => {
    const passos = [email("e1")];
    expect(proximoIrmao(passos, "fantasma")).toBeNull();
  });
});

describe("primeiroDoLado", () => {
  it("devolve o primeiro passo do lado escolhido", () => {
    const r = ramo("r1", [email("sim1")], [espera("nao1")]) as Extract<Passo, { tipo: "ramo" }>;
    expect(primeiroDoLado(r, "sim")?.id).toBe("sim1");
    expect(primeiroDoLado(r, "nao")?.id).toBe("nao1");
  });

  it("lado vazio devolve null", () => {
    const r = ramo("r1", [], []) as Extract<Passo, { tipo: "ramo" }>;
    expect(primeiroDoLado(r, "sim")).toBeNull();
  });
});
