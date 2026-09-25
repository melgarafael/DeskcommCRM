/**
 * O BOTÃO "PUBLICAR" PRECISA ACENDER DEPOIS DE SALVAR.
 *
 * Defeito medido numa instalação em produção: quem editou as
 * instruções do agente, salvou o rascunho e foi publicar encontrou o botão cinza
 * com "Salve o rascunho antes de publicar" — para sempre. Salvar de novo repetia
 * o ciclo, e a versão nova só entrou no ar por fora da tela.
 *
 * A causa não era o conteúdo: era a comparação. A tela perguntava
 * `JSON.stringify(form) !== JSON.stringify(baseline)`, e duas diferenças que não
 * são edição derrubavam isso:
 *
 *   • o servidor completa campos (a versão carregada não tinha `send_window`;
 *     a salva volta com `send_window: null`);
 *   • `jsonb` reordena as chaves (`{ignore_groups, ignore_self}` volta como
 *     `{ignore_self, ignore_groups}`) — mesmo conteúdo, string diferente.
 *
 * Estes casos são os dois de produção, mais o contraste que prova que a régua
 * não virou "tudo é igual".
 */
import { describe, expect, it } from "vitest";
import { mesmoRascunho, textoEstavel } from "./mesmo-rascunho";

const rascunhoDaTela = {
  system_prompt: "Você é o pré-vendas.",
  handoff_keywords: ["falar com humano", "pessoa real"],
  trigger_config: {
    events: ["message"],
    filters: { ignore_groups: true, ignore_self: true, keyword_regex: null },
    concurrency: "one_per_conversation",
  },
  followup: { enabled: false, flow_pointer_ids: [] },
};

describe("o botão Publicar depois de salvar", () => {
  it("a ordem das chaves que o jsonb devolve não conta como edição", () => {
    const comoOBancoDevolve = {
      ...rascunhoDaTela,
      trigger_config: {
        concurrency: "one_per_conversation",
        events: ["message"],
        filters: { ignore_self: true, keyword_regex: null, ignore_groups: true },
      },
    };
    expect(mesmoRascunho(rascunhoDaTela, comoOBancoDevolve)).toBe(true);
  });

  it("campo que o servidor completa com null não conta como edição", () => {
    const depoisDeSalvar = {
      ...rascunhoDaTela,
      followup: { enabled: false, flow_pointer_ids: [], send_window: null },
    };
    expect(mesmoRascunho(rascunhoDaTela, depoisDeSalvar)).toBe(true);
  });

  it("mudar o prompt continua sendo edição — a régua não virou 'tudo igual'", () => {
    const editado = { ...rascunhoDaTela, system_prompt: "Você é o pós-venda." };
    expect(mesmoRascunho(rascunhoDaTela, editado)).toBe(false);
  });

  it("a ordem das capacidades é conteúdo, não ruído de serialização", () => {
    const invertido = { ...rascunhoDaTela, handoff_keywords: ["pessoa real", "falar com humano"] };
    expect(mesmoRascunho(rascunhoDaTela, invertido)).toBe(false);
  });

  it("o texto canônico é estável entre chamadas", () => {
    expect(textoEstavel(rascunhoDaTela)).toBe(textoEstavel({ ...rascunhoDaTela }));
  });
});
