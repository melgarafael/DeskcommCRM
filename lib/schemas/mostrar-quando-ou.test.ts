/**
 * MAIS DE UMA CONDIÇÃO no `mostrar_quando` (issue #4041) — o OU.
 *
 * O caso real que abriu a issue é de agência de viagens: os campos de voo
 * (localizador, horários) só fazem sentido quando o negócio tem aéreo, e o
 * aéreo aparece de DUAS formas na mesma lista de escolhas — marcado como
 * "Passagem aérea" ou dentro de um "Pacote". Com uma condição só, ou os campos
 * somem dos cards de Pacote, ou aparecem em hospedagem, seguro e passeio.
 *
 * O que este arquivo prende, e por quê:
 *
 *   1. o schema ACEITA a lista (senão a chave é descartada como desconhecida,
 *      `camposDoFunil` nem a vê e a tela mostra tudo — a feature existiria só
 *      no PR);
 *   2. o campo aparece quando a PRIMEIRA condição é verdadeira, quando a
 *      SEGUNDA é, e some quando as DUAS são falsas — os três com o valor
 *      literal de cada avaliação;
 *   3. a régua é UMA: `campoVisivel`/`camposVisiveis` servem a tela
 *      (`CustomFieldsEditor`), o card (`LeadFieldsForm`) e a validação do
 *      servidor (`validaCamposExigidos`) — não há segunda cópia do OU;
 *   4. os lados opostos: condição única antiga (e o JSON gravado) intacta,
 *      lista vazia, campo inexistente, operador inválido e campo OCULTO não
 *      cobrado.
 */
import { describe, expect, it } from "vitest";

import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { validaCamposExigidos } from "@/lib/leads/campos-exigidos";
import {
  campoVisivel,
  camposVisiveis,
  condicoesDeclaradas,
  mostrarQuandoSchema,
} from "@/lib/schemas/mostrar-quando";
import { customFieldSchema, pipelineConfigPatchSchema } from "@/lib/schemas/settings";

const TIPO = "tipo_servico";
const AEREO = "Passagem aérea";
const PACOTE = "Pacote";

/** A condição do caso real: "Passagem aérea" OU "Pacote". */
const PRIMEIRA = { campo: TIPO, operador: "contem" as const, valor: AEREO };
const SEGUNDA = { campo: TIPO, operador: "contem" as const, valor: PACOTE };
const OU = { modo: "qualquer" as const, condicoes: [PRIMEIRA, SEGUNDA] };

const ETAPA = "55555555-5555-4555-8555-555555555555";

const campoDeVoo = (mostrar_quando: unknown, extra: Record<string, unknown> = {}) => ({
  key: "localizador",
  label: "Localizador do voo",
  type: "text" as const,
  mostrar_quando,
  ...extra,
});

describe("mostrar_quando com lista de condições — o schema (#4041)", () => {
  it("aceita a lista com modo 'qualquer' e sem modo (o padrão é qualquer uma)", () => {
    expect(mostrarQuandoSchema.safeParse(OU).success).toBe(true);
    expect(mostrarQuandoSchema.safeParse({ condicoes: [PRIMEIRA, SEGUNDA] }).success).toBe(true);
    expect(
      customFieldSchema.safeParse(campoDeVoo(OU)).success,
      "customFieldSchema descartaria a chave e a tela mostraria tudo",
    ).toBe(true);
  });

  it("aceita o modo 'todas' (o E), que a issue pediu como conveniência", () => {
    expect(mostrarQuandoSchema.safeParse({ modo: "todas", condicoes: [PRIMEIRA, SEGUNDA] }).success).toBe(
      true,
    );
  });

  it("recusa lista VAZIA e lista com item incompleto — não grava regra que casa com nada", () => {
    expect(mostrarQuandoSchema.safeParse({ modo: "qualquer", condicoes: [] }).success).toBe(false);
    expect(
      mostrarQuandoSchema.safeParse({ condicoes: [{ campo: TIPO, operador: "contem" }] }).success,
    ).toBe(false);
    expect(mostrarQuandoSchema.safeParse({ condicoes: [{ operador: "igual", valor: "x" }] }).success).toBe(
      false,
    );
  });

  it("o funil que já existe continua ACEITO: a condição única, na forma par e na forma da issue", () => {
    expect(mostrarQuandoSchema.safeParse({ campo: TIPO, operador: "contem", valor: AEREO }).success).toBe(
      true,
    );
    expect(mostrarQuandoSchema.safeParse({ campo: TIPO, contem: AEREO }).success).toBe(true);
    expect(customFieldSchema.safeParse(campoDeVoo({ campo: TIPO, contem: AEREO })).success).toBe(true);
  });
});

describe("a avaliação do OU — os três casos, com o valor literal (#4041)", () => {
  it("a PRIMEIRA condição sozinha, com o valor dela: verdadeira", () => {
    expect(campoVisivel(PRIMEIRA, { [TIPO]: AEREO })).toBe(true);
  });

  it("a SEGUNDA condição sozinha, com o valor dela: verdadeira", () => {
    expect(campoVisivel(SEGUNDA, { [TIPO]: PACOTE })).toBe(true);
  });

  it("GREEN 1 — valor 'Passagem aérea': a primeira casa, a segunda não, o campo APARECE", () => {
    const valores = { [TIPO]: AEREO };
    expect(campoVisivel(PRIMEIRA, valores), "primeira deveria casar").toBe(true);
    expect(campoVisivel(SEGUNDA, valores), "segunda não deveria casar").toBe(false);
    expect(campoVisivel(OU, valores)).toBe(true);
  });

  it("GREEN 2 — valor 'Pacote': a primeira NÃO casa, a segunda casa, o campo APARECE", () => {
    const valores = { [TIPO]: PACOTE };
    expect(campoVisivel(PRIMEIRA, valores)).toBe(false);
    expect(campoVisivel(SEGUNDA, valores), "segunda deveria casar").toBe(true);
    expect(campoVisivel(OU, valores)).toBe(true);
  });

  it("GREEN 3 — valor 'Hospedagem': as DUAS são falsas, o campo SOME", () => {
    const valores = { [TIPO]: "Hospedagem" };
    expect(campoVisivel(PRIMEIRA, valores)).toBe(false);
    expect(campoVisivel(SEGUNDA, valores)).toBe(false);
    expect(campoVisivel(OU, valores)).toBe(false);
  });

  it("no multiselect o item marcado basta, e a lista gravada é lida item a item", () => {
    expect(campoVisivel(OU, { [TIPO]: [PACOTE, "Hotel"] })).toBe(true);
    expect(campoVisivel(OU, { [TIPO]: ["Hotel", "Seguro"] })).toBe(false);
  });

  it("o modo 'todas' (E) só mostra quando as duas casam", () => {
    const E = { modo: "todas", condicoes: [PRIMEIRA, SEGUNDA] };
    expect(campoVisivel(E, { [TIPO]: AEREO })).toBe(false);
    expect(campoVisivel(E, { [TIPO]: [AEREO, PACOTE] })).toBe(true);
  });

  it("sem valor no campo que manda, nenhuma condição casa — o campo some", () => {
    expect(campoVisivel(OU, {})).toBe(false);
    expect(campoVisivel(OU, { [TIPO]: null })).toBe(false);
    expect(campoVisivel(OU, { [TIPO]: "" })).toBe(false);
  });

  it("caixa e acento não decidem: 'passagem AEREA' casa com 'Passagem aérea'", () => {
    expect(campoVisivel(OU, { [TIPO]: "  passagem AEREA " })).toBe(true);
  });
});

describe("camposVisiveis com lista — a régua que a tela e o servidor compartilham (#4041)", () => {
  const campos = [
    {
      key: TIPO,
      label: "Tipo de serviço",
      type: "select" as const,
      options: [
        { value: "passagem-aerea", label: AEREO },
        { value: "pacote", label: PACOTE },
        { value: "hospedagem", label: "Hospedagem" },
      ],
    },
    campoDeVoo(OU),
    { key: "hotel", label: "Hotel", type: "text" as const, mostrar_quando: { campo: TIPO, contem: "Hospedagem" } },
  ];

  it("some no card de hospedagem e volta no de Pacote e no de Passagem aérea", () => {
    expect(camposVisiveis(campos, { [TIPO]: "Hospedagem" }).map((c) => c.key)).toEqual([TIPO, "hotel"]);
    expect(camposVisiveis(campos, { [TIPO]: PACOTE }).map((c) => c.key)).toEqual([TIPO, "localizador"]);
    expect(camposVisiveis(campos, { [TIPO]: AEREO }).map((c) => c.key)).toEqual([TIPO, "localizador"]);
  });

  it("esconder não é limpar: o valor gravado continua no registro, byte a byte", () => {
    const registro: Record<string, unknown> = { [TIPO]: "Hospedagem", localizador: "ABC123" };
    const antes = JSON.stringify(registro);
    camposVisiveis(campos, registro);
    expect(JSON.stringify(registro)).toBe(antes);
  });

  it("o JSON antigo (uma condição) continua escondendo e mostrando igual", () => {
    const antigos = [campos[0]!, campoDeVoo({ campo: TIPO, contem: AEREO })];
    expect(camposVisiveis(antigos, { [TIPO]: PACOTE }).map((c) => c.key)).toEqual([TIPO]);
    expect(camposVisiveis(antigos, { [TIPO]: AEREO }).map((c) => c.key)).toEqual([TIPO, "localizador"]);
  });

  it("campo que manda ESCONDIDO não responde — mas no OU a outra condição ainda responde", () => {
    const dependentes = [
      { key: TIPO, label: "Tipo de serviço", type: "select" as const },
      { key: "tem_aereo", label: "Tem aéreo?", type: "boolean" as const, mostrar_quando: { campo: TIPO, igual: "Pacote" } },
      { key: "localizador", label: "Localizador", type: "text" as const, mostrar_quando: { modo: "qualquer" as const, condicoes: [
        { campo: "tem_aereo", igual: true },
        { campo: TIPO, igual: "Hospedagem" },
      ] } },
    ];
    // Com "Pacote" o campo que manda aparece; a primeira condição casa (valor
    // gravado falso não casa com `true`) e a segunda não — o dependente some.
    const comPacote = camposVisiveis(dependentes, { [TIPO]: "Pacote", tem_aereo: false, localizador: "XYZ" });
    expect(comPacote.map((c) => c.key)).toEqual([TIPO, "tem_aereo"]);
    // Com "Hospedagem" o que manda SOME, mas a SEGUNDA condição casa: aparece.
    const comHospedagem = camposVisiveis(dependentes, { [TIPO]: "Hospedagem", localizador: "" });
    expect(comHospedagem.map((c) => c.key)).toEqual([TIPO, "localizador"]);
  });

  it("laço com DUAS condições que mandam continua terminando (ninguém preso escondido)", () => {
    const laco = [
      { key: "a", label: "A", type: "text" as const, mostrar_quando: { modo: "qualquer" as const, condicoes: [
        { campo: "b", igual: "x" },
        { campo: "c", igual: "y" },
      ] } },
      { key: "b", label: "B", type: "text" as const, mostrar_quando: { campo: "a", igual: "z" } },
      { key: "c", label: "C", type: "text" as const },
    ];
    expect(camposVisiveis(laco, {}).map((c) => c.key)).toEqual(["a", "b", "c"]);
  });
});

describe("as linhas da tela x os itens do JSON (#4041)", () => {
  it("a linha em branco do '+ condição' CONTINUA na tela — some só no save", () => {
    // O editor monta uma linha por item da lista; se a leitura descartasse a
    // linha vazia, o botão "+ condição" não acrescentaria nada e o índice de
    // "remover"/"editar linha" passaria a apontar para a condição vizinha.
    const comBranco = { modo: "qualquer" as const, condicoes: [PRIMEIRA, { campo: "" }] };
    expect(condicoesDeclaradas(comBranco)).toHaveLength(2);
    expect(condicoesDeclaradas(comBranco)[1]).toEqual({ campo: "", operador: "igual" });
    // A condição única (`{}` solto) continua sem virar linha: não há linha a
    // acrescentar, o objeto é resto de uma condição apagada.
    expect(condicoesDeclaradas({})).toEqual([]);
    // E a posição é a posição: com a linha vazia no meio, o item 2 é o Pacote.
    const noMeio = { modo: "qualquer" as const, condicoes: [PRIMEIRA, { campo: "" }, SEGUNDA] };
    expect(condicoesDeclaradas(noMeio).map((c) => c.campo)).toEqual([TIPO, "", TIPO]);
  });
});

describe("os lados opostos (#4041)", () => {
  it("(a) condição única antiga é aceita e avaliada como sempre foi", () => {
    expect(campoVisivel({ campo: TIPO, contem: AEREO }, { [TIPO]: AEREO })).toBe(true);
    expect(campoVisivel({ campo: TIPO, contem: AEREO }, { [TIPO]: PACOTE })).toBe(false);
    expect(campoVisivel({ campo: TIPO, operador: "igual", valor: AEREO }, { [TIPO]: AEREO })).toBe(true);
  });

  it("(b) lista VAZIA não esconde o campo: ilegível é fail-open, e o schema recusa a gravação", () => {
    // Escolha de desenho: `[]` não está no formato, então a leitura é
    // "condição ilegível" e mostra — o default mais seguro, porque esconder
    // por um valor que ninguém digitou esconderia dado de todo card.
    expect(campoVisivel({ modo: "qualquer", condicoes: [] }, { [TIPO]: "Hospedagem" })).toBe(true);
    expect(mostrarQuandoSchema.safeParse({ modo: "qualquer", condicoes: [] }).success).toBe(false);
  });

  it("(c) condição citando campo INEXISTENTE não quebra: o campo aparece", () => {
    const campos = [
      campoDeVoo({ modo: "qualquer", condicoes: [
        { campo: "campo_apagado", contem: "Pacote" },
        { campo: "outro_apagado", contem: AEREO },
      ] }),
    ];
    // A régua que a tela e o servidor usam (`camposVisiveis`) conhece a LISTA de
    // campos, e é ela que sabe que a origem sumiu: condição apontando para nada
    // é ilegível e o campo APARECE — o mesmo fail-open de sempre.
    expect(() => camposVisiveis(campos, {})).not.toThrow();
    expect(camposVisiveis(campos, {}).map((c) => c.key)).toEqual(["localizador"]);
    // `campoVisivel` (uma condição contra um saco de valores, sem a lista) não
    // vê a ausência do campo e responde "não casou" — também sem lançar.
    expect(() => campoVisivel({ condicoes: [{ campo: "nao_existe", igual: "x" }] }, {})).not.toThrow();
    expect(campoVisivel({ condicoes: [{ campo: "nao_existe", igual: "x" }] }, {})).toBe(false);
  });

  it("(d) operador inválido é RECUSADO na validação do campo — safeParse, não exceção", () => {
    const invalido = campoDeVoo({ modo: "qualquer", condicoes: [
      { campo: TIPO, operador: "contem_tudo", valor: AEREO },
    ] });
    expect(() => customFieldSchema.safeParse(invalido)).not.toThrow();
    expect(customFieldSchema.safeParse(invalido).success).toBe(false);
    // A porta do save (server action `updatePipelineConfig`) usa este schema:
    // a resposta é `validation_failed`, não 500.
    expect(pipelineConfigPatchSchema.safeParse({ fields: [invalido] }).success).toBe(false);
    expect(pipelineConfigPatchSchema.safeParse({ fields: [campoDeVoo(OU)] }).success).toBe(true);
    // E o leitor do funil descarta o campo inválido em vez de explodir.
    expect(camposDoFunil({ fields: [invalido] })).toEqual([]);
  });

  it("(e) campo OCULTO pela lista NÃO é exigido na validação do servidor", () => {
    const settings = {
      fields: [
        {
          key: TIPO,
          label: "Tipo de serviço",
          type: "select",
          options: [
            { value: "aereo", label: AEREO },
            { value: "pacote", label: PACOTE },
            { value: "hospedagem", label: "Hospedagem" },
          ],
        },
        // O campo de voo é OBRIGATÓRIO na etapa — e condicionado pela lista.
        campoDeVoo(OU, { obrigatorio_em: { etapas: [ETAPA] } }),
      ],
    };

    // Card de hospedagem: o campo está OCULTO e vazio. A etapa não pode barrar
    // — senão o card fica impossível de salvar por um campo que a tela esconde.
    const hospedagem = validaCamposExigidos({
      lead: { custom_fields: { [TIPO]: "Hospedagem" } },
      settingsDoFunil: settings,
      destino: { stageId: ETAPA },
    });
    expect(hospedagem.faltando).toEqual([]);

    // O lado positivo, no MESMO funil: no Pacote o campo aparece e é cobrado.
    const pacote = validaCamposExigidos({
      lead: { custom_fields: { [TIPO]: "Pacote" } },
      settingsDoFunil: settings,
      destino: { stageId: ETAPA },
    });
    expect(pacote.faltando.map((c) => c.chave)).toEqual(["localizador"]);

    // E com o valor preenchido, o Pacote salva: a régua cobra o campo, não o OU.
    const preenchido = validaCamposExigidos({
      lead: { custom_fields: { [TIPO]: "Pacote", localizador: "XYZ987" } },
      settingsDoFunil: settings,
      destino: { stageId: ETAPA },
    });
    expect(preenchido.faltando).toEqual([]);
  });
});
