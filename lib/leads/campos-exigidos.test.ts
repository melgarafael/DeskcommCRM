/**
 * A RÉGUA ÚNICA DOS CAMPOS OBRIGATÓRIOS (issue #1536).
 *
 * Prova as quatro promessas do módulo, cada uma com o seu controle:
 *
 *   1. um funil SEM `obrigatorio_em` não exige nada, em NENHUM destino
 *      (critério de aceite nº 3 — o "comporta-se como hoje");
 *   2. `etapas`/`ao_ganhar`/`ao_perder` só cobrem o próprio gatilho;
 *   3. `false` e `0` são resposta (não ausência) — sem isto um booleano
 *      exigido seria insatisfazível e um número zero cairia em "preencha";
 *   4. o motivo de ganho nasce como CASO do contrato `faltando` (chave
 *      `won_reason`), não como código paralelo.
 *
 * E o fail-open documentado de `settingsDoFunil`: settings indisponível devolve
 * `null`, que valida como "nada exigido" — a janela sem exigência é o sistema
 * de antes, derrubar a escrita por falha de LEITURA seria trocar dado incompleto
 * por operação impossível.
 */
import { describe, expect, it, vi } from "vitest";

import {
  recusaDeCamposObrigatorios,
  recusaDeMotivoDoGanho,
  settingsDoFunil,
  validaCamposExigidos,
} from "./campos-exigidos";

const ETAPA_PROPOSTA = "55555555-5555-4555-8555-555555555555";
const ETAPA_OUTRA = "66666666-6666-4666-8666-666666666666";

function settingsDeCampo(regra: Record<string, unknown>): unknown {
  return {
    fields: [
      { key: "concorrente", label: "Concorrente", type: "text", ...regra },
    ],
  };
}

describe("validaCamposExigidos — o que o funil exige", () => {
  it("funil SEM obrigatorio_em não exige nada em nenhum destino (critério 3)", () => {
    const lead = { custom_fields: {} };
    // O campo nem tem `obrigatorio_em` — e tem `required: true`, o asterisco
    // antigo, que NÃO barra movimento (significado antigo preservado).
    const settings = {
      fields: [
        { key: "concorrente", label: "Concorrente", type: "text", required: true },
      ],
    };

    for (const destino of [
      { stageId: ETAPA_PROPOSTA },
      { stageId: ETAPA_PROPOSTA, desfecho: "won" as const },
      { stageId: ETAPA_PROPOSTA, desfecho: "lost" as const },
    ]) {
      expect(validaCamposExigidos({ lead, settingsDoFunil: settings, destino }).faltando).toEqual(
        [],
      );
    }
  });

  it("exige na etapa declarada, e devolve chave, rótulo e tipo para a tela", () => {
    const settings = settingsDeCampo({ obrigatorio_em: { etapas: [ETAPA_PROPOSTA] } });

    const falta = validaCamposExigidos({
      lead: { custom_fields: {} },
      settingsDoFunil: settings,
      destino: { stageId: ETAPA_PROPOSTA },
    });
    expect(falta.faltando).toEqual([
      { chave: "concorrente", rotulo: "Concorrente", tipo: "text" },
    ]);

    // Controle: outra etapa não cobra o mesmo campo.
    const outra = validaCamposExigidos({
      lead: { custom_fields: {} },
      settingsDoFunil: settings,
      destino: { stageId: ETAPA_OUTRA },
    });
    expect(outra.faltando).toEqual([]);
  });

  it("o valor preenchido passa — e vem do lead OU da escrita (overlay do diálogo)", () => {
    const settings = settingsDeCampo({ obrigatorio_em: { etapas: [ETAPA_PROPOSTA] } });
    const destino = { stageId: ETAPA_PROPOSTA };

    // Preenchido no lead.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { concorrente: "ACME" } },
        settingsDoFunil: settings,
        destino,
      }).faltando,
    ).toEqual([]);

    // O lead continua vazio, mas a escrita TRAZ o valor (o diálogo reenvia o
    // move com `custom_fields`): a segunda tentativa tem de passar na MESMA
    // régua que a primeira recusou.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: {} },
        settingsDoFunil: settings,
        destino,
        customFieldsPropostos: { concorrente: "ACME" },
      }).faltando,
    ).toEqual([]);
  });

  it("ao_perder só barra o fecho como perdido — movimento comum passa", () => {
    const settings = settingsDeCampo({ obrigatorio_em: { ao_perder: true } });
    const lead = { custom_fields: {} };

    // Movimento sem fecho: não pergunta.
    expect(
      validaCamposExigidos({ lead, settingsDoFunil: settings, destino: { stageId: ETAPA_OUTRA } })
        .faltando,
    ).toEqual([]);

    // Fechou como perdido: pergunta.
    expect(
      validaCamposExigidos({
        lead,
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_OUTRA, desfecho: "lost" },
      }).faltando,
    ).toEqual([{ chave: "concorrente", rotulo: "Concorrente", tipo: "text" }]);

    // Fechou como ganho: o gatilho da perda não vale.
    expect(
      validaCamposExigidos({
        lead,
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_OUTRA, desfecho: "won" },
      }).faltando,
    ).toEqual([]);
  });

  it("ao_ganhar barre o fecho como ganho, e um valor presente encerra a cobrança", () => {
    const settings = settingsDeCampo({ obrigatorio_em: { ao_ganhar: true } });

    expect(
      validaCamposExigidos({
        lead: { custom_fields: {} },
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_OUTRA, desfecho: "won" },
      }).faltando,
    ).toHaveLength(1);

    expect(
      validaCamposExigidos({
        lead: { custom_fields: { concorrente: "ACME" } },
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_OUTRA, desfecho: "won" },
      }).faltando,
    ).toEqual([]);
  });

  it("false e 0 são RESPOSTA; string em branco e array vazio são ausência", () => {
    const settings = {
      fields: [
        { key: "aceita", label: "Aceita proposta", type: "boolean", obrigatorio_em: { ao_ganhar: true } },
        { key: "parcelas", label: "Parcelas", type: "number", obrigatorio_em: { ao_ganhar: true } },
        { key: "anexos", label: "Anexos", type: "multiselect", obrigatorio_em: { ao_ganhar: true } },
        { key: "obs", label: "Observação", type: "textarea", obrigatorio_em: { ao_ganhar: true } },
      ],
    };
    const destino = { stageId: ETAPA_OUTRA, desfecho: "won" as const };

    // `false` e `0` passam: sem isto, um booleano exigido seria impossível de
    // satisfazer e o zero de "parcelas" viraria "preencha" para sempre.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { aceita: false, parcelas: 0, anexos: ["a"], obs: "ok" } },
        settingsDoFunil: settings,
        destino,
      }).faltando,
    ).toEqual([]);

    // Branco, array vazio e ausente continuam sendo ausência.
    const falta = validaCamposExigidos({
      lead: { custom_fields: { aceita: false, parcelas: 0, anexos: [], obs: "   " } },
      settingsDoFunil: settings,
      destino,
    }).faltando;
    expect(falta.map((c) => c.chave)).toEqual(["anexos", "obs"]);
  });

  it("o motivo de ganho exigido e ausente entra como faltando `won_reason` — caso do MESMO contrato", () => {
    const lead = { custom_fields: {} };
    const destino = { stageId: ETAPA_OUTRA, desfecho: "won" as const };

    // Opt-in desligado (padrão): nada muda.
    expect(
      validaCamposExigidos({ lead, settingsDoFunil: {}, destino }).faltando,
    ).toEqual([]);

    // Opt-in ligado e sem motivo: faltando com a chave que a tela já sabe ler.
    const falta = validaCamposExigidos({
      lead,
      settingsDoFunil: { won_reason_required: true },
      destino,
    }).faltando;
    expect(falta).toEqual([{ chave: "won_reason", rotulo: "Motivo do ganho" }]);

    // O motivo veio na escrita (rota `/win`): passa.
    expect(
      validaCamposExigidos({
        lead,
        settingsDoFunil: { won_reason_required: true },
        destino,
        motivoDeGanho: "Renovação anual",
      }).faltando,
    ).toEqual([]);

    // E o motivo que o lead JÁ tem também vale — reenvio idempotente.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: {}, won_reason: "Renovação anual" },
        settingsDoFunil: { won_reason_required: true },
        destino,
      }).faltando,
    ).toEqual([]);

    // O opt-in só fala do GANHO: fecho como perdido não herda a exigência.
    expect(
      validaCamposExigidos({
        lead,
        settingsDoFunil: { won_reason_required: true },
        destino: { stageId: ETAPA_OUTRA, desfecho: "lost" },
      }).faltando,
    ).toEqual([]);
  });

  it("campo OCULTO pela condição e exigido pela ETAPA continua cobrado, e vem MARCADO (#3036)", () => {
    const settings = {
      fields: [
        { key: "tipo_servico", label: "Tipo de serviço", type: "select" },
        {
          key: "outro_servico",
          label: "Outro serviço (qual?)",
          type: "text",
          obrigatorio_em: { etapas: [ETAPA_PROPOSTA] },
          mostrar_quando: { campo: "tipo_servico", contem: "Outro" },
        },
      ],
    };
    const destino = { stageId: ETAPA_PROPOSTA };

    // A ETAPA vence a condição: a regra foi ligada pelo dono do funil para a
    // etapa, e ignorá-la porque outra regra escondeu o campo abriria um buraco
    // de dado em silêncio. O marcador é o que a tela usa para DIZER por que
    // está pedindo um campo que a condição esconde.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { tipo_servico: "Limpeza" } },
        settingsDoFunil: settings,
        destino,
      }).faltando,
    ).toEqual([
      { chave: "outro_servico", rotulo: "Outro serviço (qual?)", tipo: "text", exigido_pela_etapa: true },
    ]);

    // Com o valor já gravado, o campo escondido passa: esconder não apaga, e o
    // que está no registro satisfaz a exigência da etapa.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { tipo_servico: "Limpeza", outro_servico: "Desinsetização" } },
        settingsDoFunil: settings,
        destino,
      }).faltando,
    ).toEqual([]);

    // Condição DENTRO e campo vazio: cobra, como sempre — e sem o marcador,
    // porque aqui a condição e a etapa concordam.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { tipo_servico: "Outro" } },
        settingsDoFunil: settings,
        destino,
      }).faltando.map((c) => c.chave),
    ).toEqual(["outro_servico"]);

    // E fora da etapa da regra nada é cobrado, com ou sem condição.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { tipo_servico: "Outro" } },
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_OUTRA },
      }).faltando,
    ).toEqual([]);
  });

  it("campo OCULTO não é cobrado pela CONDIÇÃO — esconder não vira bloqueio (#2728)", () => {
    const settings = {
      fields: [
        { key: "tipo_servico", label: "Tipo de serviço", type: "select" },
        {
          key: "outro_servico",
          label: "Outro serviço (qual?)",
          type: "text",
          exigir_quando: { campo: "tipo_servico", contem: "Outro" },
          mostrar_quando: { campo: "tipo_servico", contem: "Outro" },
        },
      ],
    };

    // A condição de EXIGÊNCIA não cobra o que a condição de VISIBILIDADE
    // esconde: quem não vê o campo não tem como preenchê-lo. É a promessa da
    // #2728 preservada onde ela nasceu — a exigência condicional.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { tipo_servico: "Limpeza" } },
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_PROPOSTA },
      }).faltando,
    ).toEqual([]);
  });

  it("condição que aponta para campo APAGADO é ilegível: o campo aparece e é cobrado (#2728)", () => {
    const settings = {
      fields: [
        {
          key: "outro_servico",
          label: "Outro serviço (qual?)",
          type: "text",
          obrigatorio_em: { ao_ganhar: true },
          mostrar_quando: { campo: "campo_que_foi_apagado", igual: "Outro" },
        },
      ],
    };

    // Sem quem mande, esconder seria esconder para sempre — e um exigido
    // escondido para sempre é uma exigência que ninguém vê nem cumpre.
    expect(
      validaCamposExigidos({
        lead: { custom_fields: {} },
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_PROPOSTA, desfecho: "won" },
      }).faltando.map((c) => c.chave),
    ).toEqual(["outro_servico"]);
  });

  it("laço A↔B é condição ilegível: os dois aparecem e os dois são cobrados (#2728)", () => {
    const settings = {
      fields: [
        {
          key: "a",
          label: "A",
          type: "text",
          obrigatorio_em: { etapas: [ETAPA_PROPOSTA] },
          mostrar_quando: { campo: "b", igual: "sim" },
        },
        {
          key: "b",
          label: "B",
          type: "text",
          obrigatorio_em: { etapas: [ETAPA_PROPOSTA] },
          mostrar_quando: { campo: "a", igual: "sim" },
        },
      ],
    };

    expect(
      validaCamposExigidos({
        lead: { custom_fields: {} },
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_PROPOSTA },
      }).faltando.map((c) => c.chave),
    ).toEqual(["a", "b"]);
  });
});

describe("recusaDeCamposObrigatorios — a frase da recusa", () => {
  it("nomeia os rótulos, na ordem dos campos, e carrega o código novo", () => {
    const recusa = recusaDeCamposObrigatorios(
      [
        { chave: "concorrente", rotulo: "Concorrente" },
        { chave: "data_prevista", rotulo: "Data prevista" },
      ],
      "pt-BR",
    );
    expect(recusa.codigo).toBe("required_fields_missing");
    expect(recusa.mensagem).toContain("Concorrente, Data prevista");
  });
});

describe("recusaDeMotivoDoGanho — a lista do funil", () => {
  it("sem lista cadastrada o motivo é texto livre (não há o que recusar)", () => {
    expect(
      recusaDeMotivoDoGanho({ motivo: "Qualquer coisa", settingsDoFunil: {}, idioma: "pt-BR" }),
    ).toBeNull();
    expect(
      recusaDeMotivoDoGanho({ motivo: null, settingsDoFunil: { won_reasons: ["X"] } }),
    ).toBeNull();
  });

  it("com lista, o que está nela passa e o que não está vira won_reason_invalid", () => {
    const settings = { won_reasons: ["Expansão de contrato", "Renovação"] };

    expect(
      recusaDeMotivoDoGanho({ motivo: "Renovação", settingsDoFunil: settings, idioma: "pt-BR" }),
    ).toBeNull();

    const recusa = recusaDeMotivoDoGanho({
      motivo: "Mentira comercial",
      settingsDoFunil: settings,
      idioma: "pt-BR",
    });
    expect(recusa).toMatchObject({ codigo: "won_reason_invalid" });
    expect(recusa?.mensagem).toContain("não está na lista");
  });
});

describe("settingsDoFunil — fail-open documentado", () => {
  it("lê o settings quando o funil responde", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { settings: { won_reason_required: true } }, error: null }),
          }),
        }),
      }),
    } as never;

    await expect(settingsDoFunil(supabase, "33333333-3333-4333-8333-333333333333")).resolves.toEqual({
      won_reason_required: true,
    });
  });

  it("erro de consulta, exceção ou pipeline ausente devolvem null — nada exigido", async () => {
    const comErro = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }),
      }),
    } as never;
    await expect(settingsDoFunil(comErro, "33333333-3333-4333-8333-333333333333")).resolves.toBeNull();

    // Exceção (dublê que não serve a tabela, rede caída): capturada, não propaga.
    const queExige = { from: () => { throw new Error("tabela inesperada"); } } as never;
    await expect(settingsDoFunil(queExige, "33333333-3333-4333-8333-333333333333")).resolves.toBeNull();

    // Sem pipeline não há o que perguntar.
    await expect(settingsDoFunil({} as never, null)).resolves.toBeNull();
    void vi;
  });
});

describe("campo de escopo contato não entra na régua do negócio (issue #2791)", () => {
  it("um campo do contato com obrigatorio_em NÃO barra o movimento do negócio", () => {
    const settings = {
      fields: [
        {
          key: "cor_favorita",
          label: "Cor favorita",
          type: "text",
          escopo: "contato",
          obrigatorio_em: { etapas: [ETAPA_PROPOSTA] },
        },
      ],
    };
    expect(
      validaCamposExigidos({
        lead: { custom_fields: {} },
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_PROPOSTA },
      }).faltando,
    ).toEqual([]);
  });

  it("o MESMO campo marcado como do negócio volta a barrar — o controle", () => {
    const settings = {
      fields: [
        {
          key: "concorrente",
          label: "Concorrente",
          type: "text",
          escopo: "negocio",
          obrigatorio_em: { etapas: [ETAPA_PROPOSTA] },
        },
      ],
    };
    expect(
      validaCamposExigidos({
        lead: { custom_fields: {} },
        settingsDoFunil: settings,
        destino: { stageId: ETAPA_PROPOSTA },
      }).faltando.map((c) => c.chave),
    ).toEqual(["concorrente"]);
  });
});

/**
 * CAMPOS CONDICIONAIS (#3036) — a obrigatoriedade POR VALOR, compondo com a
 * obrigatoriedade por ETAPA (#1536) e com a visibilidade (#2728).
 *
 * O caso real da issue é o roteiro deste bloco: "Tipo de cliente = PJ" exige a
 * condição de pagamento ao mover de Proposta para Fechamento; para PF os campos
 * não aparecem e não são cobrados.
 */
describe("validaCamposExigidos — exigir_quando, a obrigatoriedade por valor (#3036)", () => {
  const FECHAMENTO = "77777777-7777-4777-8777-777777777777";

  /** O funil do caso real: PJ pede a condição de pagamento, PF não. */
  const funilComTipoDeCliente = {
    fields: [
      {
        key: "tipo_cliente",
        label: "Tipo de cliente",
        type: "select",
        options: [
          { value: "PJ", label: "Pessoa jurídica" },
          { value: "PF", label: "Pessoa física" },
        ],
      },
      {
        key: "condicao_pagamento",
        label: "Condição de pagamento",
        type: "text",
        exigir_quando: { campo: "tipo_cliente", operador: "igual", valor: "PJ" },
      },
    ],
  };

  const valida = (customFields: Record<string, unknown>, destino = { stageId: FECHAMENTO }) =>
    validaCamposExigidos({
      lead: { custom_fields: customFields },
      settingsDoFunil: funilComTipoDeCliente,
      destino,
    }).faltando.map((c) => c.chave);

  it("PJ exige a condição de pagamento; PF não exige nada (o caso da issue)", () => {
    expect(valida({ tipo_cliente: "PJ" })).toEqual(["condicao_pagamento"]);
    expect(valida({ tipo_cliente: "PF" })).toEqual([]);
  });

  it("a condição reavalia a CADA valor do campo de origem — trocar na hora muda o veredito", () => {
    // A mesma escrita, variando só o valor que manda: é o que a tela faz a cada
    // tecla, porque a régua é chamada com os valores correntes.
    const veredito = ["PF", "PJ", "PF", ""].map((tipo) => valida({ tipo_cliente: tipo }));
    expect(veredito).toEqual([[], ["condicao_pagamento"], [], []]);
  });

  it("preenchido o campo, a condição fica satisfeita — e o valor NÃO é apagado", () => {
    const customFields = { tipo_cliente: "PJ", condicao_pagamento: "30/60/90" };
    expect(valida(customFields)).toEqual([]);
    // A régua só LÊ: nenhum caminho aqui reescreve `custom_fields`.
    expect(customFields).toEqual({ tipo_cliente: "PJ", condicao_pagamento: "30/60/90" });
  });

  it("o conjunto `em` cobre mais de um valor do campo de origem", () => {
    const settings = {
      fields: [
        { key: "tipo_cliente", label: "Tipo de cliente", type: "select" },
        {
          key: "inscricao_estadual",
          label: "Inscrição estadual",
          type: "text",
          exigir_quando: { campo: "tipo_cliente", operador: "em", valor: ["PJ", "MEI"] },
        },
      ],
    };
    const chaves = (tipo: string) =>
      validaCamposExigidos({
        lead: { custom_fields: { tipo_cliente: tipo } },
        settingsDoFunil: settings,
        destino: { stageId: FECHAMENTO },
      }).faltando.map((c) => c.chave);

    expect(chaves("PJ")).toEqual(["inscricao_estadual"]);
    expect(chaves("MEI")).toEqual(["inscricao_estadual"]);
    expect(chaves("PF")).toEqual([]);
  });

  it("o valor PROPOSTO na mesma escrita conta — o diálogo do arrasto reenvia o move", () => {
    // Sem isto a segunda tentativa cairia na mesma recusa da primeira: o lead
    // ainda não foi gravado, e o valor vem em `customFieldsPropostos` (#1536).
    expect(
      validaCamposExigidos({
        lead: { custom_fields: {} },
        settingsDoFunil: funilComTipoDeCliente,
        destino: { stageId: FECHAMENTO },
        customFieldsPropostos: { tipo_cliente: "PJ", condicao_pagamento: "À vista" },
      }).faltando,
    ).toEqual([]);
  });

  it("a etapa CONTINUA exigindo o que ela sempre exigiu — a condição não a substitui", () => {
    // CONTROLE: campo exigido pela etapa, sem condição nenhuma. É a régua que a
    // issue manda preservar, e ela vale mesmo com outro campo do funil tendo
    // `exigir_quando`.
    const settings = {
      fields: [
        ...funilComTipoDeCliente.fields,
        {
          key: "concorrente",
          label: "Concorrente",
          type: "text",
          obrigatorio_em: { etapas: [FECHAMENTO] },
        },
      ],
    };
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { tipo_cliente: "PF" } },
        settingsDoFunil: settings,
        destino: { stageId: FECHAMENTO },
      }).faltando,
    ).toEqual([{ chave: "concorrente", rotulo: "Concorrente", tipo: "text" }]);
  });

  it("condição ilegível não exige nada — exigir por lixo no banco travaria a escrita", () => {
    const settings = {
      fields: [
        {
          key: "condicao_pagamento",
          label: "Condição de pagamento",
          type: "text",
          exigir_quando: { campo: "", operador: "igual", valor: "PJ" },
        },
        {
          key: "outro",
          label: "Outro",
          type: "text",
          exigir_quando: { campo: "tipo_cliente", operador: "operador_que_nao_existe", valor: "PJ" },
        },
      ],
    };
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { tipo_cliente: "PJ" } },
        settingsDoFunil: settings,
        destino: { stageId: FECHAMENTO },
      }).faltando,
    ).toEqual([]);
  });

  it("campo do CONTATO com exigir_quando é inerte, como as marcas de etapa (#2791)", () => {
    const settings = {
      fields: [
        { key: "tipo_cliente", label: "Tipo de cliente", type: "select" },
        {
          key: "aniversario",
          label: "Aniversário",
          type: "text",
          escopo: "contato",
          exigir_quando: { campo: "tipo_cliente", valor: "PJ" },
        },
      ],
    };
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { tipo_cliente: "PJ" } },
        settingsDoFunil: settings,
        destino: { stageId: FECHAMENTO },
      }).faltando,
    ).toEqual([]);
  });
});
