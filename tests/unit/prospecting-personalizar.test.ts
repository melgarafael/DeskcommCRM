import { describe, expect, it } from "vitest";
import {
  blocoVozVendedor,
  lerPersonalizacao,
  personalizacaoDaOrganizacao,
} from "@/lib/prospecting/personalizar";
import { vocabularioDoNicho } from "@/lib/prospecting/estrategia-site";

describe("personalizar", () => {
  it("lê a fatia sem nunca lançar", () => {
    expect(lerPersonalizacao(null)).toEqual({});
    expect(lerPersonalizacao("lixo")).toEqual({});
    expect(lerPersonalizacao({ prospeccao: null })).toEqual({});
    expect(
      lerPersonalizacao({ prospeccao: { vendedor_nome: "Ana", vocabulario: { clinica: "pacientes" } } }),
    ).toEqual({ vendedor_nome: "Ana", vocabulario: { clinica: "pacientes" } });
    // Chave desconhecida recusa a fatia inteira (strict), sem cair no parcial.
    expect(lerPersonalizacao({ prospeccao: { outra_coisa: 1 } })).toEqual({});
  });

  it("voz vazia não muda o prompt", () => {
    expect(blocoVozVendedor({})).toBe("");
    const bloco = blocoVozVendedor({ vendedor_nome: "Ana", vendedor_diferencial: "resposta em 1h" });
    expect(bloco).toContain("Ana");
    expect(bloco).toContain("1h");
  });

  it("override da org vence o mapa base", () => {
    expect(vocabularioDoNicho("clínica", { clinica: "convênios" })).toBe("convênios");
    expect(vocabularioDoNicho("clínica", null)).toBe("agenda de pacientes");
    expect(vocabularioDoNicho("clínica", {})).toBe("agenda de pacientes");
  });

  it("falha de banco vira vazio (fail-open)", async () => {
    const db = {
      query: async () => {
        throw new Error("banco fora");
      },
    };
    await expect(personalizacaoDaOrganizacao(db, "org")).resolves.toEqual({});
  });

  it("lê settings da linha da org", async () => {
    const db = {
      query: async () => ({ rows: [{ settings: { prospeccao: { vendedor_nome: "Ana" } } }] }),
    };
    await expect(personalizacaoDaOrganizacao(db, "org")).resolves.toEqual({ vendedor_nome: "Ana" });
  });
});
