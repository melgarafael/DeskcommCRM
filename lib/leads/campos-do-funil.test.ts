import { describe, expect, it } from "vitest";

import {
  campoEhDoContato,
  camposDeDataDoNegocio,
  camposDoFunil,
  camposPorEscopo,
  camposPorEscopoDosFunis,
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

// Issue #4929 — o lápis da lista abre o diálogo da ficha, e a lista não tem funil:
// o conjunto é a união dos campos de CONTATO de todos os funis, a mesma que o
// PATCH valida. A união é por CHAVE — dois funis podem ter rótulos iguais em
// campos diferentes, e juntar por rótulo apagaria um deles.
describe("camposPorEscopoDosFunis", () => {
  const funilVendas = {
    fields: [
      { key: "codigo_parceiro", label: "Código do parceiro", type: "text", escopo: "contato" },
      { key: "valor_da_venda", label: "Valor da venda", type: "currency" },
      { key: "aniversario", label: "Aniversário", type: "date", escopo: "contato" },
    ],
  };
  const funilSuporte = {
    fields: [
      // A MESMA chave, com outro rótulo: uma definição só, a primeira na ordem.
      { key: "codigo_parceiro", label: "Parceiro", type: "text", escopo: "contato" },
      // O MESMO rótulo, com outra chave: são dois campos, e os dois aparecem.
      { key: "codigo_do_chamado", label: "Código do parceiro", type: "text", escopo: "contato" },
      { key: "sla", label: "SLA", type: "number" },
    ],
  };

  it("junta os campos do contato de todos os funis e deixa o negócio de fora", () => {
    expect(
      camposPorEscopoDosFunis([funilVendas, funilSuporte], "contato").map((c) => c.key),
    ).toEqual(["codigo_parceiro", "aniversario", "codigo_do_chamado"]);
  });

  it("desempata por CHAVE, nunca por rótulo: a primeira definição da chave vence", () => {
    const codigos = camposPorEscopoDosFunis([funilVendas, funilSuporte], "contato").filter(
      (c) => c.key === "codigo_parceiro",
    );
    expect(codigos).toHaveLength(1);
    expect(codigos[0]?.label).toBe("Código do parceiro");
    // Rótulos iguais em chaves diferentes sobrevivem os dois.
    expect(
      camposPorEscopoDosFunis([funilVendas, funilSuporte], "contato").filter(
        (c) => c.label === "Código do parceiro",
      ),
    ).toHaveLength(2);
  });

  it("lê o escopo do negócio pela mesma função, e lixo não derruba a lista", () => {
    expect(
      camposPorEscopoDosFunis([funilVendas, funilSuporte], "negocio").map((c) => c.key),
    ).toEqual(["valor_da_venda", "sla"]);
    expect(camposPorEscopoDosFunis([null, "x", [1], undefined, funilVendas], "contato")).toHaveLength(2);
    expect(camposPorEscopoDosFunis([], "contato")).toEqual([]);
  });
});
