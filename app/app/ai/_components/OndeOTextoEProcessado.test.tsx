/**
 * A TELA DIZ ONDE O TEXTO É PROCESSADO — INCLUSIVE QUANDO A RESPOSTA É "NÃO SEI".
 *
 * O caso fácil é o provedor que declara país: a linha repete o dado do catálogo
 * com a fonte e a data. O caso que este arquivo existe para guardar é o outro:
 * provedor sem país, endpoint do operador e modelo local têm de APARECER. Sumir
 * com a linha faria a tela parecer completa e o operador concluir que o texto
 * não sai do país — a conclusão errada que a cláusula de transferência do
 * contrato existe para evitar.
 *
 * O último caso é a defesa em profundidade: país declarado sem fonte não é país.
 * Se ele chegar assim (dado torto, consumidor que não passou pelo tipo), a tela
 * diz "não declara" em vez de repetir uma afirmação sem procedência.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PROVEDORES, PROVEDORES_DE_DECISAO } from "@/lib/ai/pontos/provedores";
import { PROVEDORES_DE_SERVICO } from "@/lib/ai/pontos/provedores-de-servico";

import { OndeOTextoEProcessado } from "./OndeOTextoEProcessado";

function linha(provedor: { pais: string; fonteDoPais: { url: string; consultadoEm: string } | null }, enderecoProprio?: string) {
  render(<OndeOTextoEProcessado provedor={provedor} enderecoProprio={enderecoProprio ?? null} />);
  return screen.getByTestId("onde-o-texto-e-processado");
}

describe("OndeOTextoEProcessado — as quatro respostas, e nenhuma delas é silêncio", () => {
  it("provedor que declara país: mostra o país, o link da fonte e a data da consulta", () => {
    const deepseek = PROVEDORES.find((p) => p.id === "deepseek");
    expect(deepseek?.fonteDoPais, "o catálogo deixou de trazer fonte para a DeepSeek").toBeTruthy();

    const el = linha(deepseek!);
    expect(el).toHaveAttribute("data-situacao", "declarado");
    expect(el).toHaveTextContent("Onde o texto é processado: China");
    expect(el).toHaveTextContent("consultada em 12/11/2026");
    const fonte = screen.getByRole("link", { name: "fonte: política do provedor" });
    expect(fonte).toHaveAttribute("href", deepseek!.fonteDoPais!.url);
  });

  it("provedor que não declara país: aparece o aviso, em vez de a linha sumir", () => {
    const anthropic = PROVEDORES.find((p) => p.id === "anthropic");
    const el = linha(anthropic!);
    expect(el).toHaveAttribute("data-situacao", "desconhecido");
    expect(el).toHaveTextContent("O provedor não declara o país; consulte a política dele");
    // Nada de país inventado: o nome do provedor não vira "Estados Unidos".
    expect(el).not.toHaveTextContent("Estados Unidos");
  });

  it("modelo no servidor do operador: diz que nada sai da instalação", () => {
    const el = linha({ pais: "local", fonteDoPais: null });
    expect(el).toHaveAttribute("data-situacao", "local");
    expect(el).toHaveTextContent("Neste servidor — nada sai da instalação");
  });

  it("endpoint próprio configurado vence o catálogo: quem escolheu o endereço sabe onde ele fica", () => {
    const deepseek = PROVEDORES.find((p) => p.id === "deepseek");
    const el = linha(deepseek!, "https://meu-gateway.exemplo.com/v1");
    expect(el).toHaveAttribute("data-situacao", "endereco_proprio");
    expect(el).toHaveTextContent("Endereço definido por você — o CRM não sabe onde ele fica");
    expect(el).not.toHaveTextContent("China");
  });

  it("país declarado sem fonte não é país: a tela cai para o desconhecido declarado", () => {
    const el = linha({ pais: "Estados Unidos", fonteDoPais: null });
    expect(el).toHaveAttribute("data-situacao", "desconhecido");
    expect(el).toHaveTextContent("O provedor não declara o país; consulte a política dele");
    expect(el).not.toHaveTextContent("Estados Unidos");
  });

  it("todo provedor oferecido tem linha na tela — nem que seja para dizer 'não sei'", () => {
    const todos = [...PROVEDORES, ...PROVEDORES_DE_DECISAO, ...PROVEDORES_DE_SERVICO];
    expect(todos.length, "a varredura não enxergou o catálogo").toBeGreaterThan(8);

    for (const provedor of todos) {
      const { unmount } = render(
        <OndeOTextoEProcessado provedor={provedor} enderecoProprio={null} />,
      );
      const el = screen.getByTestId("onde-o-texto-e-processado");
      // A linha existe e tem texto: `null` no componente reprova aqui.
      expect(el.textContent?.trim().length, `${provedor.id} ficou sem texto`).toBeGreaterThan(10);
      expect(el).toHaveTextContent("Onde o texto é processado:");
      unmount();
    }
  });
});
