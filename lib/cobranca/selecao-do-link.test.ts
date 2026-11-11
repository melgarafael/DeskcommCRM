import { describe, expect, it } from "vitest";
import { selecionarPlanoDoLink } from "./selecao-do-link";

const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
] as const;
const oferecidos = ids.map((id) => ({ id }));
const resolver = (pedido: string | string[] | undefined, convite = false) =>
  selecionarPlanoDoLink(pedido, oferecidos, ids[0], convite);

describe("seleção de plano pelo link público", () => {
  it.each(ids)("seleciona exatamente o plano oferecido %s", (id) => {
    expect(resolver(id)).toEqual({ planoInicial: id, linkInvalido: false, linkEscolheuPlano: true });
  });
  it("sem pedido mantém o padrão e o caminho Google existente", () => {
    expect(resolver(undefined)).toEqual({ planoInicial: ids[0], linkInvalido: false, linkEscolheuPlano: false });
  });
  const recusados: (string | string[])[] = ["10000000-0000-4000-8000-000000000099", "", "https://externo.test", [ids[1], ids[2]]];
  it.each(recusados)("recusa plano privado/inválido/ambíguo, avisa e não tira o Google: %s", (pedido) => {
    expect(resolver(pedido)).toEqual({ planoInicial: ids[0], linkInvalido: true, linkEscolheuPlano: false });
  });
  it("sem plano oferecido, o link é ignorado: nem aviso nem Google escondido", () => {
    for (const pedido of [ids[1], "abc"]) {
      expect(selecionarPlanoDoLink(pedido, [], undefined, false)).toEqual({ planoInicial: undefined, linkInvalido: false, linkEscolheuPlano: false });
    }
  });
  it("convite tem precedência sobre uma escolha válida ou inválida", () => {
    for (const pedido of [ids[1], "inválido"]) {
      expect(resolver(pedido, true)).toEqual({ planoInicial: ids[0], linkInvalido: false, linkEscolheuPlano: false });
    }
  });
});
