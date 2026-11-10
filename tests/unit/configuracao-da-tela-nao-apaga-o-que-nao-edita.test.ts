/**
 * A REGRA DE MERGE DO CARTÃO (issue #3792), fora do React.
 *
 * O formulário da extensão instalada edita densidade, descrição e — quando o
 * manifesto declara um tema — a paleta. O corpo do `PUT /api/v1/extensions/
 * :id/configuration` SUBSTITUI a configuração, então tudo o que a tela não
 * edita tem de ser levado de volta: `configuration.theme` (o tema ligado pela
 * API) e qualquer outra chave gravada que esta tela não conheça.
 *
 * `configuracaoAoSalvar` é a única expressão dessa regra. Este teste a fixa:
 * chave não editada sobrevive, `theme` só sai quando a pessoa escolhe
 * "Nenhuma", paleta que o manifesto não declara não é gravada, e o objeto
 * recebido não é mutado.
 */
import { describe, expect, it } from "vitest";

import { configuracaoAoSalvar } from "@/lib/extensions/configuracao-da-tela";
import type { ExtensionConfiguration } from "@/lib/extensions/manifest";

describe("configuracaoAoSalvar", () => {
  it("preserva o tema gravado quando a tela não editou o campo de paleta", () => {
    const gravada: ExtensionConfiguration = {
      density: "comfortable",
      show_description: true,
      theme: "sage",
    };

    const corpo = configuracaoAoSalvar(
      gravada,
      { density: "compact", show_description: false },
      null,
    );

    // A tela não edita `theme` aqui: um pacote que não declara tema não é motivo
    // para apagar, em silêncio, a escolha que a organização fez pela API.
    expect(corpo).toEqual({ density: "compact", show_description: false, theme: "sage" });
  });

  it("preserva chave gravada que a tela não edita", () => {
    // O CHECK do banco só admite estas chaves hoje. A regra é a do spread, não a
    // da lista de campos do formulário: uma chave nova que a tela não mostre não
    // pode ser apagada por um salvamento de densidade.
    const gravada = {
      density: "comfortable",
      show_description: true,
      algo_do_futuro: "preservado",
    } as unknown as ExtensionConfiguration;

    const corpo = configuracaoAoSalvar(
      gravada,
      { density: "compact", show_description: true },
      null,
    );

    expect(corpo).toEqual({
      density: "compact",
      show_description: true,
      algo_do_futuro: "preservado",
    });
  });

  it("grava a paleta escolhida e mantém o resto do formulário", () => {
    const corpo = configuracaoAoSalvar(
      { density: "comfortable", show_description: true },
      { density: "comfortable", show_description: false, theme: { escolha: "plum" } },
      "plum",
    );

    expect(corpo).toEqual({ density: "comfortable", show_description: false, theme: "plum" });
  });

  it("tira a chave `theme` quando a pessoa escolhe 'Nenhuma'", () => {
    const corpo = configuracaoAoSalvar(
      { density: "comfortable", show_description: true, theme: "sage" },
      { density: "comfortable", show_description: true, theme: { escolha: null } },
      "sage",
    );

    // O banco não guarda `null` em `configuration.theme`: desligar é a chave SUMIR.
    expect("theme" in corpo).toBe(false);
    expect(corpo).toEqual({ density: "comfortable", show_description: true });
  });

  it("não grava paleta que o manifesto não declara", () => {
    const corpo = configuracaoAoSalvar(
      { density: "comfortable", show_description: true },
      { density: "comfortable", show_description: true, theme: { escolha: "clay" } },
      null,
    );

    // Sem `contributions.theme` no manifesto o gancho não aplica nada: gravar a
    // paleta seria prometer uma tela pintada que nunca acontece.
    expect("theme" in corpo).toBe(false);
  });

  it("não muta a configuração recebida", () => {
    const gravada: ExtensionConfiguration = {
      density: "comfortable",
      show_description: true,
      theme: "sage",
    };
    configuracaoAoSalvar(
      gravada,
      { density: "compact", show_description: false, theme: { escolha: null } },
      "sage",
    );

    expect(gravada).toEqual({ density: "comfortable", show_description: true, theme: "sage" });
  });
});
