/**
 * O CAMPO DE LISTA PESQUISÁVEL (#2521) — o tipo, a régua, a busca e a importação.
 *
 * O defeito que estes casos trancam: `text` aceita `Gramado`, `gramado` e
 * `GRAMADO` como três valores, e o filtro/relatório de "quantos negócios para
 * Maceió?" soma seis grafias. O tipo novo existe para gravar SEMPRE o valor
 * canônico da opção, recusar o que não está na lista (salvo `allow_new`) e
 * permitir carregar a base em lote.
 *
 * Os quatro critérios de sucesso da issue, um bloco cada:
 *   (a) grava/le o valor padronizado (definição round-trip + canonicalização);
 *   (b) valor fora da lista é RECUSADO (política escolhida; `allow_new` abre);
 *   (c) a busca por prefixo acha a opção certa (sem caixa/acento/espaço);
 *   (d) a importação cria as opções em lote SEM duplicar.
 */
import { describe, expect, it } from "vitest";

import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import {
  buscarOpcoes,
  exportarOpcoesCsv,
  importarOpcoesCsv,
  normalizarParaBusca,
  opcoesDoCampo,
  validarValorPesquisavel,
  valorCanonico,
  type OpcaoPesquisavel,
} from "@/lib/leads/campos-pesquisaveis";
import { customFieldSchema } from "@/lib/schemas/settings";

/** A lista do exemplo da issue: destinos com apelidos em várias grafias. */
const DESTINOS: OpcaoPesquisavel[] = [
  { value: "maceio-al", label: "Maceió (AL)", aliases: ["maceio", "mcz"] },
  { value: "gramado-rs", label: "Gramado (RS)" },
  { value: "nova-york", label: "Nova York", aliases: ["New York", "NY", "NYC"] },
];

describe("(a) o tipo grava e lê o valor padronizado", () => {
  it("a definição `searchable_select` sobrevive ao round-trip do schema e da leitura do funil", () => {
    const definicao = {
      key: "destino",
      label: "Destino",
      type: "searchable_select",
      allow_new: false,
      options: [
        { value: "maceio-al", label: "Maceió (AL)", aliases: ["maceio", "mcz"] },
        { value: "gramado-rs", label: "Gramado (RS)" },
      ],
    };
    const parsed = customFieldSchema.safeParse(definicao);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // O schema não pode DESCARTAR `aliases`/`allow_new` (z.object sem eles os
    // removeria em silêncio — a lista perderia apelidos e a válvula).
    expect(parsed.data.options?.[0]?.aliases).toEqual(["maceio", "mcz"]);
    expect(parsed.data.allow_new).toBe(false);

    // E o mesmo caminho que o card/dossiê/IA leem devolve a definição inteira.
    const lidos = camposDoFunil({ fields: [definicao] });
    expect(lidos).toHaveLength(1);
    expect(lidos[0]?.type).toBe("searchable_select");
    expect(lidos[0]?.options?.[0]?.aliases).toEqual(["maceio", "mcz"]);
  });

  it("grava o `value` canônico, não o texto digitado", () => {
    // As três grafias do relatório apontam para a MESMA opção.
    expect(valorCanonico(DESTINOS, "maceio")).toBe("maceio-al");
    expect(valorCanonico(DESTINOS, "MACEIÓ")).toBe("maceio-al");
    expect(valorCanonico(DESTINOS, "Maceio")).toBe("maceio-al");
    // E por apelido de outra opção.
    expect(valorCanonico(DESTINOS, "ny")).toBe("nova-york");
    expect(valorCanonico(DESTINOS, " new  york ")).toBe("nova-york");
    // O que não é opção não tem canônico.
    expect(valorCanonico(DESTINOS, "Paris")).toBeNull();
  });
});

describe("(b) valor fora da lista é recusado — a política escolhida", () => {
  const campo = customFieldSchema.parse({
    key: "destino",
    label: "Destino",
    type: "searchable_select",
    options: DESTINOS,
  });

  it("RECUSA (`fora_da_lista`) o valor que não casa e não tem `allow_new`", () => {
    const r = validarValorPesquisavel(campo, "Paris");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("fora_da_lista");
  });

  it("normaliza o valor que casa — grava o canônico, não a grafia digitada", () => {
    const r = validarValorPesquisavel(campo, "maceió");
    expect(r).toEqual({ ok: true, valor: "maceio-al" });
  });

  it("com `allow_new` ligado, aceita o valor novo aparado", () => {
    const comNovo = { ...campo, allow_new: true };
    const r = validarValorPesquisavel(comNovo, "  Paris  ");
    expect(r).toEqual({ ok: true, valor: "Paris" });
  });

  it("vazio nunca é recusado — limpar é escrita válida", () => {
    expect(validarValorPesquisavel(campo, "")).toEqual({ ok: true, valor: "" });
    expect(validarValorPesquisavel(campo, null)).toEqual({ ok: true, valor: null });
    expect(validarValorPesquisavel(campo, undefined)).toEqual({ ok: true, valor: undefined });
  });

  it("NÃO muda o comportamento de nenhum tipo que já existe", () => {
    const texto = customFieldSchema.parse({ key: "obs", label: "Obs", type: "text" });
    // Um `select`/`text` grava o valor cru como sempre; nada passa pela régua.
    expect(validarValorPesquisavel(texto, "qualquer coisa")).toEqual({
      ok: true,
      valor: "qualquer coisa",
    });
  });
});

describe("(c) a busca por prefixo acha a opção certa", () => {
  it("ignora caixa, acento e espaço", () => {
    const achados = buscarOpcoes(DESTINOS, "mace");
    expect(achados.map((o) => o.value)).toContain("maceio-al");
    expect(buscarOpcoes(DESTINOS, "MACEIÓ").map((o) => o.value)).toContain("maceio-al");
    expect(buscarOpcoes(DESTINOS, "gramado").map((o) => o.value)).toContain("gramado-rs");
    expect(buscarOpcoes(DESTINOS, "new york").map((o) => o.value)).toContain("nova-york");
  });

  it("acha por APELIDO", () => {
    expect(buscarOpcoes(DESTINOS, "nyc").map((o) => o.value)).toContain("nova-york");
    expect(buscarOpcoes(DESTINOS, "mcz").map((o) => o.value)).toContain("maceio-al");
  });

  it("põe o prefixo antes do 'contém' e respeita o limite", () => {
    const lista: OpcaoPesquisavel[] = [
      { value: "x", label: "Alagoas — Maceió" }, // contém
      { value: "maceio-al", label: "Maceió (AL)" }, // prefixo
    ];
    const achados = buscarOpcoes(lista, "mace");
    expect(achados[0]?.value).toBe("maceio-al");
    expect(buscarOpcoes(lista, "mace", 1)).toHaveLength(1);
  });

  it("termo vazio devolve o começo da lista (o autocompletar abre com algo)", () => {
    expect(buscarOpcoes(DESTINOS, "").length).toBe(DESTINOS.length);
  });
});

describe("(d) a importação cria as opções em lote sem duplicar", () => {
  it("lê `value,label,apelidos` e acrescenta à lista existente", () => {
    const r = importarOpcoesCsv(
      [{ value: "maceio-al", label: "Maceió (AL)" }],
      [
        "value,label,aliases", // cabeçalho ignorado
        "gramado-rs,Gramado (RS)",
        "nova-york,Nova York,New York;NY;NYC",
      ].join("\n"),
    );
    expect(r.adicionadas.map((o) => o.value)).toEqual(["gramado-rs", "nova-york"]);
    expect(r.opcoes.map((o) => o.value)).toEqual(["maceio-al", "gramado-rs", "nova-york"]);
    expect(r.opcoes.find((o) => o.value === "nova-york")?.aliases).toEqual([
      "New York",
      "NY",
      "NYC",
    ]);
    expect(r.ignoradas).toEqual([]);
  });

  it("NÃO duplica: nem o que já existe, nem a repetição dentro do próprio arquivo", () => {
    const r = importarOpcoesCsv(
      [{ value: "maceio-al", label: "Maceió (AL)" }],
      ["Maceió (AL)", "maceio-al", "GRAMA"].join("\n"),
    );
    // As duas grafias de Maceió já existentes são ignoradas.
    expect(r.adicionadas.map((o) => o.value)).toEqual(["GRAMA"]);
    expect(r.ignoradas).toEqual(["Maceió (AL)", "maceio-al"]);
  });

  it("label vazio cai no value; linhas em branco somem", () => {
    const r = importarOpcoesCsv([], "salvador, \n\n   \nrecife");
    expect(r.opcoes).toEqual([
      { value: "salvador", label: "salvador" },
      { value: "recife", label: "recife" },
    ]);
  });
});

describe("normalização (base de tudo)", () => {
  it("colapsa caixa, acento e espaço", () => {
    expect(normalizarParaBusca("  MACEIÓ  ")).toBe("maceio");
    expect(normalizarParaBusca("Nova   York")).toBe("nova york");
    expect(normalizarParaBusca("Ação")).toBe("acao");
  });

  it("`opcoesDoCampo` só lê o que o campo tem", () => {
    expect(opcoesDoCampo({ options: undefined })).toEqual([]);
    expect(opcoesDoCampo({ options: [{ value: "a", label: "A" }] })[0]).toEqual({
      value: "a",
      label: "A",
    });
  });
});

/**
 * (e) EXPORTAR A LISTA (sugestão 3 da issue #3176) — o par do (d) acima.
 *
 * O caso que importa não é "gera um texto": é o CICLO. O arquivo que o botão
 * baixa tem de ser um arquivo que o "Importar" aceita, e o que voltar dele tem
 * de ser a MESMA lista — com o `value` canônico (é o que os negócios já
 * gravados usam) e com os apelidos da importação. Um export que só imprime
 * rótulos quebraria a ida e volta em silêncio, e é isso que o round-trip abaixo
 * tranca.
 */
describe("(e) o exportar CSV fecha o ciclo com a importação", () => {
  it("escreve `value,label,apelidos` com o cabeçalho que a importação pula", () => {
    const csv = exportarOpcoesCsv(DESTINOS);
    const linhas = csv.split("\n");
    expect(linhas[0]).toBe("value,label,apelidos");
    expect(linhas[1]).toBe("maceio-al,Maceió (AL),maceio;mcz");
    expect(linhas[2]).toBe("gramado-rs,Gramado (RS),");
    // Sem apelidos a coluna fica vazia — e a linha termina ali.
    expect(linhas).toHaveLength(DESTINOS.length + 2); // +0. o cabeçalho, +1. o \n final
  });

  it("o que sai VOLTA pelo importar: mesmos `value`s, rótulos e apelidos, sem duplicar", () => {
    const csv = exportarOpcoesCsv(DESTINOS);
    const r = importarOpcoesCsv([], csv);
    expect(r.ignoradas).toEqual([]);
    expect(r.adicionadas).toEqual(DESTINOS);
    expect(r.opcoes).toEqual(DESTINOS);
    // E reimportar o próprio arquivo num funil que já tem a lista não duplica
    // nada: é o ciclo "exportar, editar fora, reimportar" sem susto.
    const deNovo = importarOpcoesCsv(DESTINOS, csv);
    expect(deNovo.adicionadas).toEqual([]);
    expect(deNovo.opcoes).toEqual(DESTINOS);
  });

  it("lista vazia exporta só o cabeçalho — o arquivo continua sendo um CSV válido", () => {
    expect(exportarOpcoesCsv([])).toBe("value,label,apelidos\n");
  });
});

/**
 * (f) O MODO MÚLTIPLO DA LISTA PESQUISÁVEL (#3182).
 *
 * O defeito: um negócio "forfait" tem vários fornecedores e vários hotéis, e a
 * lista pesquisável só guardava UM valor canônico — a régua aceitava apenas
 * string e RECUSAVA array (`fora_da_lista`), então quem escolhia o segundo
 * fornecedor perdia o primeiro. O conserto é o campo declarar `multiple: true`
 * e a escrita virar uma LISTA de valores canônicos, canonicalizada ITEM A ITEM
 * pela mesma `valorCanonico` — recusando só o item que não casa sem `allow_new`.
 */
describe("(f) o modo múltiplo grava uma LISTA de valores canônicos (#3182)", () => {
  const FORNECEDORES = customFieldSchema.parse({
    key: "fornecedores",
    label: "Fornecedores",
    type: "searchable_select",
    multiple: true,
    options: [
      { value: "consolidadora-a", label: "Consolidadora A", aliases: ["consol a"] },
      { value: "operadora-b", label: "Operadora B", aliases: ["B"] },
      { value: "seguradora-c", label: "Seguradora C" },
    ],
  });

  it("o schema e a leitura do funil NÃO descartam `multiple`", () => {
    expect(FORNECEDORES.multiple).toBe(true);
    const lidos = camposDoFunil({ fields: [FORNECEDORES] });
    expect(lidos[0]?.multiple).toBe(true);
  });

  it("canonicaliza ITEM A ITEM e devolve a lista de `value` canônicos", () => {
    // Duas grafias escolhidas na tela: o rótulo e um apelido de caixa trocada.
    expect(validarValorPesquisavel(FORNECEDORES, ["Consolidadora A", "b"])).toEqual({
      ok: true,
      valor: ["consolidadora-a", "operadora-b"],
    });
  });

  it("recusa a escrita por UM item que não casa, sem `allow_new`", () => {
    const r = validarValorPesquisavel(FORNECEDORES, ["consolidadora-a", "Fornecedor X"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("fora_da_lista");
  });

  it("com `allow_new`, o item novo passa aparado — e só ele", () => {
    const comNovo = { ...FORNECEDORES, allow_new: true };
    expect(validarValorPesquisavel(comNovo, ["Consolidadora A", "  Fornecedor X  "])).toEqual({
      ok: true,
      valor: ["consolidadora-a", "Fornecedor X"],
    });
  });

  it("duas grafias da MESMA opção viram um item só (a lista é canônica)", () => {
    expect(validarValorPesquisavel(FORNECEDORES, ["Consolidadora A", "consolidadora-a"])).toEqual({
      ok: true,
      valor: ["consolidadora-a"],
    });
  });

  it("lista vazia e `null` nunca são recusados — limpar é escrita válida", () => {
    expect(validarValorPesquisavel(FORNECEDORES, [])).toEqual({ ok: true, valor: [] });
    expect(validarValorPesquisavel(FORNECEDORES, null)).toEqual({ ok: true, valor: null });
    expect(validarValorPesquisavel(FORNECEDORES, undefined)).toEqual({
      ok: true,
      valor: undefined,
    });
  });

  it("sem `multiple`, o tipo segue de valor único: array continua recusado", () => {
    const unico = customFieldSchema.parse({
      key: "fornecedor",
      label: "Fornecedor",
      type: "searchable_select",
      options: [{ value: "consolidadora-a", label: "Consolidadora A" }],
    });
    const r = validarValorPesquisavel(unico, ["consolidadora-a"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("fora_da_lista");
  });
});
