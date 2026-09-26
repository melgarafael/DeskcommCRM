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
