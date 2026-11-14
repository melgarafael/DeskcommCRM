/**
 * A LINHA QUE SÓ EXISTE QUANDO O CAMPO EXISTE (#4339).
 *
 * ─── O defeito, medido ─────────────────────────────────────────────────────
 *
 * A automação imprime o campo do negócio direto no corpo. Quando o campo ainda
 * não foi preenchido, o cliente recebe o RÓTULO sozinho:
 *
 *   `🔢 Apólice: {{seguro_apolice}}`  →  `🔢 Apólice: `
 *
 * A reserva (`{{campo|"texto"}}`) piora: ela põe um texto que parece pendência
 * ("segue no documento") no lugar de sumir com a linha. A saída que existia era
 * uma regra por combinação de campos preenchidos — duas linhas condicionais já
 * dão quatro regras, e a conta cresce.
 *
 * ─── A saída é ADITIVA: `{{#campo}}...{{/campo}}` ──────────────────────────
 *
 * O miolo sai quando a variável tem valor e SAI VAZIO quando não tem — e, se o
 * bloco era o conteúdo da linha, a linha inteira some com o `\n`. NADA que já
 * existe muda: texto sem `{{#` é renderizado byte a byte como antes.
 *
 * ─── O que cada conjunto prova ─────────────────────────────────────────────
 *
 *   (a) a linha do rótulo some (o corpo de duas linhas da issue, uma vazia);
 *   (b) o campo com valor continua saindo, com a data no idioma da empresa —
 *       o bloco e o `|data` (#4339) juntos, não um em vez do outro;
 *   (c) as quatro telas: automação e follow-up apagam; Inbox e campanha MANTÊM
 *       a linha, porque nelas a variável sem valor continua visível como token;
 *   (d) sintaxe errada não apaga conteúdo: `{{#campo}}` sem fechamento é texto;
 *   (e) bloco no meio da linha com texto em volta só perde o miolo — declarado;
 *   (f) e-mail: assunto e corpo passam pelo mesmo render.
 */
import { describe, expect, it } from "vitest";

import { renderizar } from "@/lib/campanhas/renderizador";
import { renderTemplate } from "@/lib/automation/template";
import { renderizarTextoDeFollowup } from "@/lib/automation/texto-do-followup";
import { resolverVariaveis } from "@/lib/variaveis/resolvedor";

/** O contexto de render de uma automação, com o idioma/fuso da organização. */
function contexto(
  campos: Record<string, unknown>,
  organizacao: { idioma?: string; fuso?: string } = {},
): Record<string, unknown> {
  return {
    contact: { name: "Ana", phone_number: "+551****7777" },
    lead: { title: "Seguro de viagem", custom_fields: campos },
    __render: organizacao,
  };
}

/** O corpo da issue, como quem escreve a regra digita. */
const CORPO_DA_ISSUE = [
  "Sua viagem está confirmada.",
  "🔢 Apólice: {{seguro_apolice}}",
  "📞 Assistência 24h: {{seguro_emergencia}}",
].join("\n");

describe("(a) a linha do rótulo some quando o campo está vazio", () => {
  it("⚠️ o corpo da issue, com os DOIS campos vazios, não deixa rótulo nem buraco", () => {
    const comBlocos = [
      "Sua viagem está confirmada.",
      "{{#seguro_apolice}}🔢 Apólice: {{seguro_apolice}}{{/seguro_apolice}}",
      "{{#seguro_emergencia}}📞 Assistência 24h: {{seguro_emergencia}}{{/seguro_emergencia}}",
    ].join("\n");

    // Sem o bloco, o que o cliente recebia era isto — rótulo e dois-pontos
    // pendurados, e a reserva não resolvia (ela imprime texto no lugar).
    const antes = [
      "Sua viagem está confirmada.",
      "🔢 Apólice: {{seguro_apolice}}",
      "📞 Assistência 24h: {{seguro_emergencia}}",
    ].join("\n");
    expect(renderTemplate(antes, contexto({}))).toBe(
      ["Sua viagem está confirmada.", "🔢 Apólice: ", "📞 Assistência 24h: "].join("\n"),
    );

    // Com o bloco: as duas linhas saem, e a mensagem fica inteira.
    expect(renderTemplate(comBlocos, contexto({}))).toBe("Sua viagem está confirmada.");
  });

  it("campo preenchido mantém a linha, e o vizinho vazio some — sem linha em branco no meio", () => {
    const comBlocos = [
      "Sua viagem está confirmada.",
      "{{#seguro_apolice}}🔢 Apólice: {{seguro_apolice}}{{/seguro_apolice}}",
      "{{#seguro_emergencia}}📞 Assistência 24h: {{seguro_emergencia}}{{/seguro_emergencia}}",
      "Qualquer dúvida, fale com a gente.",
    ].join("\n");

    expect(renderTemplate(comBlocos, contexto({ seguro_apolice: "AP-9981" }))).toBe(
      [
        "Sua viagem está confirmada.",
        "🔢 Apólice: AP-9981",
        "Qualquer dúvida, fale com a gente.",
      ].join("\n"),
    );
  });

  it("o corpo SEM bloco continua idêntico — nada muda para quem já usa", () => {
    expect(renderTemplate(CORPO_DA_ISSUE, contexto({}))).toBe(
      ["Sua viagem está confirmada.", "🔢 Apólice: ", "📞 Assistência 24h: "].join("\n"),
    );
  });
});

describe("(b) bloco com valor e data no idioma da organização, na mesma linha", () => {
  it("`{{#data_inicio}}` + `{{data_inicio|data}}` sai 20/11/2026 em pt-BR", () => {
    const corpo = [
      "Seguro contratado.",
      "{{#data_inicio}}🗓️ Início: {{data_inicio|data}}{{/data_inicio}}",
      "{{#data_fim}}🗓️ Fim: {{data_fim|data}}{{/data_fim}}",
    ].join("\n");

    expect(renderTemplate(corpo, contexto({ data_inicio: "2026-11-20" }))).toBe(
      ["Seguro contratado.", "🗓️ Início: 20/11/2026"].join("\n"),
    );
  });

  it("o mesmo corpo em espanhol mantém dia antes do mês", () => {
    const corpo = "{{#data_inicio}}Inicio: {{data_inicio|data}}{{/data_inicio}}";
    expect(renderTemplate(corpo, contexto({ data_inicio: "2026-11-20" }, { idioma: "es" }))).toBe(
      "Inicio: 20/11/2026",
    );
  });
});

describe("(c) cada tela com a política que ela já usa", () => {
  it("follow-up (política `remover`) apaga a linha do campo vazio", () => {
    const texto =
      "Oi {{primeiro_nome}}!\n{{#lead.title}}Sobre: {{lead.title}}{{/lead.title}}\nAté logo.";
    expect(renderizarTextoDeFollowup(texto, { contact: { name: "Ana" } })).toBe(
      "Oi Ana!\nAté logo.",
    );
  });

  it("Inbox (política `literal`) MANTÉM a linha: o rascunho mostra o token", () => {
    const resolvido = resolverVariaveis(
      "Apólice: {{#seguro_apolice}}{{seguro_apolice}}{{/seguro_apolice}}",
      { lead: { custom_fields: {} } },
      { fonte: "inbox", quandoVazio: "literal" },
    );
    expect(resolvido.texto).toBe("Apólice: {{seguro_apolice}}");
  });

  it("campanha (política `pular`) MANTÉM a linha e marca a pessoa", () => {
    const resolvido = renderizar(
      "Apólice: {{#seguro_apolice}}{{lead.seguro_apolice}}{{/seguro_apolice}}",
      { nome: "Ana", lead: {} },
    );
    expect(resolvido.texto).toContain("{{lead.seguro_apolice}}");
    expect(resolvido.faltando).toContain("lead.seguro_apolice");
  });
});

describe("(d) sintaxe errada não apaga conteúdo", () => {
  it("`{{#campo}}` sem fechamento fica como texto, e o resto da frase sobrevive", () => {
    const texto = "Antes {{#seguro_apolice}} depois";
    expect(renderTemplate(texto, contexto({}))).toBe("Antes {{#seguro_apolice}} depois");
  });

  it("fechamento de OUTRO nome não fecha o bloco", () => {
    const texto = "{{#a}}A{{/b}}";
    expect(renderTemplate(texto, contexto({ a: "1" }))).toBe("{{#a}}A{{/b}}");
  });
});

describe("(e) bloco no meio da linha: só o miolo sai, a linha fica", () => {
  it("texto antes e depois do bloco sobrevive", () => {
    const texto = "Apólice: {{#seguro_apolice}}nº {{seguro_apolice}}{{/seguro_apolice}} (via app)";
    expect(renderTemplate(texto, contexto({}))).toBe("Apólice:  (via app)");
  });
});

describe("(f) e-mail: assunto e corpo pelo mesmo render", () => {
  it("assunto com bloco vazio perde só o trecho condicional", () => {
    const assunto = "Sua viagem{{#seguro_apolice}} — apólice {{seguro_apolice}}{{/seguro_apolice}}";
    expect(renderTemplate(assunto, contexto({}))).toBe("Sua viagem");
    expect(renderTemplate(assunto, contexto({ seguro_apolice: "AP-9981" }))).toBe(
      "Sua viagem — apólice AP-9981",
    );
  });
});
