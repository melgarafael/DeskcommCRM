import { describe, expect, it } from "vitest";

import {
  campoEhDoContato,
  camposDeDataDoNegocio,
  camposDoFunil,
  camposPorEscopo,
  escopoDoCampo,
  settingsDoEmbed,
} from "./campos-do-funil";
import { customFieldSchema } from "@/lib/schemas/settings";

describe("camposDoFunil", () => {
  it("ignora entradas que não passam no schema", () => {
    expect(
      camposDoFunil({
        fields: [{ key: "endereco", label: "Endereço", type: "text" }, { key: "??" }],
      }),
    ).toEqual([{ key: "endereco", label: "Endereço", type: "text" }]);
  });
});

describe("settingsDoEmbed", () => {
  it("lê o objeto to-one do PostgREST", () => {
    expect(
      settingsDoEmbed({ settings: { fields: [{ key: "empresa", label: "Empresa", type: "text" }] } }),
    ).toEqual({ fields: [{ key: "empresa", label: "Empresa", type: "text" }] });
  });

  it("lê array (relação que vacilou) pelo primeiro item", () => {
    expect(settingsDoEmbed([{ settings: { fields: [] } }])).toEqual({ fields: [] });
  });

  it("lixo vira null — o painel mostra os campos padrão, não explode", () => {
    expect(settingsDoEmbed(null)).toBeNull();
    expect(settingsDoEmbed("x")).toBeNull();
    expect(settingsDoEmbed({ settings: "não" })).toBeNull();
    expect(settingsDoEmbed({ settings: [1] })).toBeNull();
  });
});

describe("escopoDoCampo (issue #2791)", () => {
  it("a AUSÊNCIA é negocio — nenhuma definição que já existe muda de comportamento", () => {
    expect(escopoDoCampo({})).toBe("negocio");
    expect(escopoDoCampo({ escopo: undefined })).toBe("negocio");
  });

  it("lê os dois valores declarados", () => {
    expect(escopoDoCampo({ escopo: "negocio" })).toBe("negocio");
    expect(escopoDoCampo({ escopo: "contato" })).toBe("contato");
  });
});

describe("camposPorEscopo (issue #2791)", () => {
  const settings = {
    fields: [
      { key: "cor_favorita", label: "Cor favorita", type: "text", escopo: "contato" },
      { key: "prazo", label: "Prazo", type: "date", escopo: "negocio" },
      { key: "endereco", label: "Endereço", type: "text" },
    ],
  };
  const campos = camposDoFunil(settings);

  it("o escopo contato separa o que a ficha do contato mostra", () => {
    expect(camposPorEscopo(campos, "contato").map((c) => c.key)).toEqual(["cor_favorita"]);
  });

  it("o escopo negocio leva o campo do negócio e o campo sem escopo (o de sempre)", () => {
    expect(camposPorEscopo(campos, "negocio").map((c) => c.key)).toEqual(["prazo", "endereco"]);
  });

  it("parte a lista em dois sem perder nem duplicar campo", () => {
    const contato = camposPorEscopo(campos, "contato").length;
    const negocio = camposPorEscopo(campos, "negocio").length;
    expect(contato + negocio).toBe(campos.length);
  });
});

describe("customFieldSchema: o escopo (issue #2791)", () => {
  it("aceita os dois valores e a ausência", () => {
    expect(customFieldSchema.safeParse({ key: "k", label: "K", type: "text" }).success).toBe(true);
    expect(
      customFieldSchema.safeParse({ key: "k", label: "K", type: "text", escopo: "contato" }).success,
    ).toBe(true);
    expect(
      customFieldSchema.safeParse({ key: "k", label: "K", type: "text", escopo: "negocio" }).success,
    ).toBe(true);
  });

  it("recusa escopo que não seja os dois declarados", () => {
    expect(
      customFieldSchema.safeParse({ key: "k", label: "K", type: "text", escopo: "empresa" }).success,
    ).toBe(false);
  });
});

describe("camposDeDataDoNegocio: o que o gatilho por data pode usar (achado na prova do #2852)", () => {
  const settings = {
    fields: [
      { key: "nascimento", label: "Nascimento", type: "date", escopo: "contato" },
      { key: "entrega", label: "Entrega", type: "date", escopo: "negocio" },
      { key: "casamento", label: "Casamento", type: "date" },
      { key: "endereco", label: "Endereço", type: "text" },
    ],
  };

  it("oferece só data do NEGÓCIO (declarada ou sem escopo) — o campo do contato fica de fora", () => {
    expect(camposDeDataDoNegocio(settings).map((c) => c.key)).toEqual(["entrega", "casamento"]);
  });

  it("campoEhDoContato: a recusa do servidor reconhece só a chave declarada como do contato", () => {
    expect(campoEhDoContato(settings, "nascimento")).toBe(true);
    expect(campoEhDoContato(settings, "entrega")).toBe(false);
    expect(campoEhDoContato(settings, "casamento")).toBe(false);
    // Chave não declarada é livre no custom_fields do negócio, e a varredura a lê.
    expect(campoEhDoContato(settings, "nao_declarada")).toBe(false);
    expect(campoEhDoContato(null, "nascimento")).toBe(false);
  });
});
