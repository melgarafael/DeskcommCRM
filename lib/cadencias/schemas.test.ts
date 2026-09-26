import { describe, expect, it } from "vitest";

import { cadenciaDeExemplo, configuracaoPadrao } from "./exemplos";
import {
  configuracaoDaCadenciaSchema,
  criarCadenciaSchema,
  editarCadenciaSchema,
  inscreverLeadSchema,
  mudarStatusDaCadenciaSchema,
  passoSchema,
} from "./schemas";

describe("passoSchema", () => {
  it("aceita cada tipo de passo, inclusive um ramo com filhos", () => {
    const exemplo = cadenciaDeExemplo();
    for (const passo of exemplo.passos) {
      expect(passoSchema.safeParse(passo).success).toBe(true);
    }
  });

  it("recusa um passo sem o discriminante `tipo`", () => {
    expect(passoSchema.safeParse({ id: "x", assunto: "a", corpo: "b" }).success).toBe(false);
  });

  it("recusa um ramo cujo lado 'sim' tem um passo inválido", () => {
    const ramoComFilhoInvalido = {
      id: "r1",
      tipo: "ramo",
      condicao: { tipo: "abriu", vezes: 1, dentroDeDias: 3 },
      sim: [{ id: "e1", tipo: "email" /* falta assunto/corpo/mesmaConversa */ }],
      nao: [],
    };
    expect(passoSchema.safeParse(ramoComFilhoInvalido).success).toBe(false);
  });
});

describe("configuracaoDaCadenciaSchema", () => {
  it("aceita a configuração padrão", () => {
    expect(configuracaoDaCadenciaSchema.safeParse(configuracaoPadrao()).success).toBe(true);
  });

  it("recusa horário fora do formato HH:MM", () => {
    const invalida = { ...configuracaoPadrao(), janela: { ...configuracaoPadrao().janela, inicio: "8h" } };
    expect(configuracaoDaCadenciaSchema.safeParse(invalida).success).toBe(false);
  });
});

describe("criarCadenciaSchema", () => {
  it("recusa nome vazio", () => {
    expect(criarCadenciaSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("aceita nome e tag opcionais", () => {
    expect(criarCadenciaSchema.safeParse({ name: "Papel e celulose" }).success).toBe(true);
  });
});

describe("editarCadenciaSchema", () => {
  it("recusa corpo vazio (nada para atualizar)", () => {
    expect(editarCadenciaSchema.safeParse({}).success).toBe(false);
  });

  it("aceita só o nome", () => {
    expect(editarCadenciaSchema.safeParse({ name: "Novo nome" }).success).toBe(true);
  });
});

describe("mudarStatusDaCadenciaSchema", () => {
  it("recusa status fora do vocabulário", () => {
    expect(mudarStatusDaCadenciaSchema.safeParse({ status: "arquivada" }).success).toBe(false);
  });
});

describe("inscreverLeadSchema", () => {
  it("exige lead_id em formato uuid", () => {
    expect(inscreverLeadSchema.safeParse({ lead_id: "não-é-uuid" }).success).toBe(false);
    expect(inscreverLeadSchema.safeParse({ lead_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }).success).toBe(true);
  });
});
