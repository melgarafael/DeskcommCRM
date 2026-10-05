import { describe, expect, it } from "vitest";

import { filtrarOpcoes, type OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";

const OPCOES: OpcaoDeSelecao[] = [
  { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", keywords: ["anthropic/claude-sonnet-4-6"] },
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", keywords: ["anthropic/claude-haiku-4-5"] },
  { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", keywords: ["google/gemini-2.5-pro"] },
  { value: "e1", label: "São Paulo — Negociação" },
  { value: "3f9a0c2e-1111-4a4a-8888-aaaaaaaaaaaa", label: "Chave principal" },
];

const rotulos = (lista: OpcaoDeSelecao[]) => lista.map((o) => o.label);

describe("filtrarOpcoes", () => {
  it("busca vazia devolve tudo, numa lista nova", () => {
    const resultado = filtrarOpcoes(OPCOES, "   ");
    expect(resultado).toEqual(OPCOES);
    expect(resultado).not.toBe(OPCOES);
  });

  it("ignora maiúscula e acento", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "sao paulo"))).toEqual(["São Paulo — Negociação"]);
    expect(rotulos(filtrarOpcoes(OPCOES, "NEGOCIACAO"))).toEqual(["São Paulo — Negociação"]);
  });

  it("cada palavra precisa aparecer, em qualquer ordem", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "4 sonnet"))).toEqual(["Claude Sonnet 4.6"]);
    expect(rotulos(filtrarOpcoes(OPCOES, "claude"))).toEqual(["Claude Sonnet 4.6", "Claude Haiku 4.5"]);
  });

  it("acha pelo identificador técnico quando ele vem em keywords", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "anthropic/claude-haiku"))).toEqual(["Claude Haiku 4.5"]);
  });

  it("pontuação na busca não atrapalha", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "gemini-2.5"))).toEqual(["Gemini 2.5 Pro"]);
  });

  it("NÃO procura no value: um uuid casaria com quase toda letra digitada", () => {
    expect(rotulos(filtrarOpcoes(OPCOES, "aaaa"))).toEqual([]);
  });

  it("nada casa → lista vazia", () => {
    expect(filtrarOpcoes(OPCOES, "xyz")).toEqual([]);
  });
});
