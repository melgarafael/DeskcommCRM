import { describe, expect, it } from "vitest";

/**
 * OS CAMPOS DO CARD NO RESUMO DA PASSAGEM (issue #4303) — a régua PURA.
 *
 * O resumo que a pessoa lê ao assumir a conversa não mostrava os campos
 * personalizados do CARD: consumo em kWh, valor da conta — o dado que decide a
 * próxima frase de quem atende — só aparecia para quem abria o negócio, com o
 * cliente esperando.
 *
 * O que este arquivo prova, caso por caso:
 *
 *   (a) TODOS DESLIGADOS → resumo IDÊNTICO ao de hoje, string inteira. É a
 *       prova negativa que protege as instalações existentes: nenhum funil
 *       antigo (jsonb sem a chave) muda um byte;
 *   (b) um campo marcado e preenchido → aparece com o RÓTULO do campo e o
 *       valor como o card mostra;
 *   (c) marcado e SEM valor → não aparece (nada de "Consumo: —");
 *   (e) mais campos marcados que o teto → o teto de hoje manda (12), sem
 *       estourar e sem mexer em `MAX_CAMPOS_COLETADOS`.
 *
 * A escolha do CARD (dois negócios abertos, nunca somar) e o recorte de
 * organização têm arquivo próprio (`handoff-resumo-do-card.test.ts`), porque
 * dependem do caminho — estes são da régua pura.
 */

import { montarBriefingDaPassagem } from "@/lib/escalacao/briefing-da-passagem";
import { camposDoCardParaResumo, camposMarcadosNoResumo } from "@/lib/leads/campos-do-resumo-da-passagem";

/** Um funil com os campos do caso real da issue. */
function funil(opcoes: {
  consumo?: boolean;
  valor?: boolean;
  observacao?: boolean;
}): Record<string, unknown> {
  return {
    fields: [
      {
        key: "consumo_kwh",
        label: "Consumo (kWh)",
        type: "number",
        ...(opcoes.consumo === true ? { mostrar_no_resumo_da_passagem: true } : {}),
      },
      {
        key: "valor_da_conta",
        label: "Valor da conta",
        type: "currency",
        ...(opcoes.valor === true ? { mostrar_no_resumo_da_passagem: true } : {}),
      },
      {
        key: "observacao",
        label: "Observação",
        type: "text",
        ...(opcoes.observacao === true ? { mostrar_no_resumo_da_passagem: true } : {}),
      },
    ],
  };
}

const CHECKPOINT = {
  commitments: ["enviar a fatura revisada"],
  objections: [],
  next_action: "confirmar a leitura do relógio",
  rolling_summary: "O cliente pediu revisão da conta de luz.",
};

const PENDENTES = ["a conta veio muito alta, quero falar com alguém"];

/** O resumo de HOJE: montado sem nenhum campo de card. */
function resumoDeHoje(): string {
  return montarBriefingDaPassagem({
    checkpoint: CHECKPOINT,
    pendentesDoCliente: PENDENTES,
    motivo: { codigo: "requested_human" },
  }).body;
}

/** O resumo de hoje + o bloco de campos do card (o caminho novo). */
function resumoComCampos(campos: Record<string, string>): string {
  return montarBriefingDaPassagem({
    checkpoint: CHECKPOINT,
    pendentesDoCliente: PENDENTES,
    motivo: { codigo: "requested_human" },
    camposColetados: campos,
  }).body;
}

describe("(a) desligado por padrão: resumo byte a byte o de hoje", () => {
  it("campo sem a chave — o jsonb de toda instalação existente — não entra", () => {
    const campos = camposDoCardParaResumo(funil({}), { consumo_kwh: 320, valor_da_conta: 189.9 });
    expect(campos).toEqual({});
    // A comparação é da STRING INTEIRA: qualquer linha a mais quebra a
    // instalação que hoje já está certa.
    expect(resumoComCampos(campos)).toBe(resumoDeHoje());
  });

  it("chave explícita `false` também não entra", () => {
    const settings = {
      fields: [
        { key: "consumo_kwh", label: "Consumo (kWh)", type: "number", mostrar_no_resumo_da_passagem: false },
      ],
    };
    expect(camposDoCardParaResumo(settings, { consumo_kwh: 320 })).toEqual({});
    expect(resumoComCampos(camposDoCardParaResumo(settings, { consumo_kwh: 320 }))).toBe(resumoDeHoje());
  });

  it("funil velho (settings nulo, fields que não é lista) não explode", () => {
    expect(camposDoCardParaResumo(null, { consumo_kwh: 320 })).toEqual({});
    expect(camposDoCardParaResumo({ fields: "lixo" }, { consumo_kwh: 320 })).toEqual({});
    expect(camposDoCardParaResumo({ fields: [{ key: "", label: "", type: "nada" }] }, {})).toEqual({});
  });
});

describe("(b) ligado: aparece com o RÓTULO e o valor do card", () => {
  it("número entra com o rótulo, nunca com a chave crua", () => {
    const campos = camposDoCardParaResumo(funil({ consumo: true }), { consumo_kwh: 320 });
    expect(campos).toEqual({ "Consumo (kWh)": "320" });

    const body = resumoComCampos(campos);
    expect(body).toContain("• Consumo (kWh): 320");
    expect(body).not.toContain("consumo_kwh");
  });

  it("moeda da ORGANIZAÇÃO formata o valor, como o card mostra", () => {
    const campos = camposDoCardParaResumo(funil({ valor: true }), { valor_da_conta: 189.9 }, { moeda: "BRL" });
    expect(Object.keys(campos)).toEqual(["Valor da conta"]);
    expect(campos["Valor da conta"]).toMatch(/R\$\s*189,90/);
  });

  it("lista mostra o RÓTULO da opção, não o value canônico", () => {
    const settings = {
      fields: [
        {
          key: "tarifa",
          label: "Tarifa",
          type: "select",
          options: [
            { value: "branca", label: "Tarifa branca" },
            { value: "convencional", label: "Convencional" },
          ],
          mostrar_no_resumo_da_passagem: true,
        },
      ],
    };
    expect(camposDoCardParaResumo(settings, { tarifa: "branca" })).toEqual({ Tarifa: "Tarifa branca" });
    expect(
      camposDoCardParaResumo({ fields: [{ ...settings.fields[0], type: "multiselect" }] }, {
        tarifa: ["branca", "convencional"],
      }),
    ).toEqual({ Tarifa: "Tarifa branca, Convencional" });
  });

  it("booleano sai em palavra, como na tela de revisão", () => {
    const settings = {
      fields: [{ key: "titular", label: "É o titular?", type: "boolean", mostrar_no_resumo_da_passagem: true }],
    };
    expect(camposDoCardParaResumo(settings, { titular: true })).toEqual({ "É o titular?": "Sim" });
  });

  it("só o campo MARCADO entra: o desligado não vira linha", () => {
    const campos = camposDoCardParaResumo(funil({ consumo: true }), {
      consumo_kwh: 320,
      valor_da_conta: 189.9,
      observacao: "portão aberto",
    });
    expect(Object.keys(campos)).toEqual(["Consumo (kWh)"]);
  });
});

describe("(c) marcado e SEM valor: não aparece", () => {
  it("ausente, nulo, branco e lista vazia não viram '—'", () => {
    const settings = funil({ consumo: true, valor: true, observacao: true });
    for (const customFields of [
      {},
      { consumo_kwh: null, valor_da_conta: undefined, observacao: "   " },
      { consumo_kwh: [], valor_da_conta: [], observacao: [] },
    ]) {
      const campos = camposDoCardParaResumo(settings, customFields);
      expect(campos).toEqual({});
      expect(resumoComCampos(campos)).toBe(resumoDeHoje());
    }
  });

  it("objeto (jsonb que não é escalar nem lista) não vira [object Object]", () => {
    const settings = funil({ observacao: true });
    expect(camposDoCardParaResumo(settings, { observacao: { a: 1 } })).toEqual({});
  });
});

describe("(e) teto do bloco: mais marcados que o limite não estoura", () => {
  it("12 campos no resumo, o 13º fora — o teto de hoje manda", () => {
    const fields = Array.from({ length: 15 }, (_, i) => ({
      key: `campo_${i + 1}`,
      label: `Campo ${i + 1}`,
      type: "text",
      mostrar_no_resumo_da_passagem: true,
    }));
    const customFields = Object.fromEntries(fields.map((f, i) => [f.key, `valor ${i + 1}`]));

    const campos = camposDoCardParaResumo({ fields }, customFields);
    // A função pura não corta: quem corta é a montagem (uma regra só).
    expect(Object.keys(campos)).toHaveLength(15);

    const body = resumoComCampos(campos);
    const linhas = body.split("\n").filter((l) => l.startsWith("• "));
    expect(linhas).toHaveLength(12);
    expect(body).toContain("• Campo 12: valor 12");
    expect(body).not.toContain("Campo 13");
  });
});

describe("o que NÃO entra por definição", () => {
  it("campo de escopo CONTATO não tem valor no card e não é oferecido", () => {
    const settings = {
      fields: [
        {
          key: "cpf",
          label: "CPF",
          type: "text",
          escopo: "contato",
          mostrar_no_resumo_da_passagem: true,
        },
      ],
    };
    expect(camposMarcadosNoResumo(settings)).toEqual([]);
    expect(camposDoCardParaResumo(settings, { cpf: "000" })).toEqual({});
  });

  it("campo de ARQUIVO mora em outra tabela e não entra", () => {
    const settings = {
      fields: [{ key: "conta_pdf", label: "Conta (PDF)", type: "file", mostrar_no_resumo_da_passagem: true }],
    };
    expect(camposDoCardParaResumo(settings, { conta_pdf: "abc" })).toEqual({});
  });
});
