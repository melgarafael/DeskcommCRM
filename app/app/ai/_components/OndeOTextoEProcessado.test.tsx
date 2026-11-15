/**
 * A TELA DIZ ONDE O TEXTO É PROCESSADO — INCLUSIVE QUANDO A RESPOSTA É "NÃO SEI".
 *
 * O caso fácil é o provedor que declara país: a linha traduz o CÓDIGO do
 * catálogo (`US`, `CN`, `UE`) no nome que a cláusula 9 imprime, e acrescenta
 * link e data quando o provedor tem fonte própria. Os outros casos são os que
 * este arquivo existe para guardar: provedor sem país, endpoint do operador e
 * modelo local têm de APARECER. Sumir com a linha faria a tela parecer completa
 * e o operador concluir que o texto não sai do país — a conclusão errada que a
 * cláusula de transferência do contrato existe para evitar.
 *
 * O último caso é a defesa em profundidade: valor fora do vocabulário não é
 * país. Se ele chegar assim (texto livre da versão anterior do campo, dado
 * torto de um consumidor que não passou pelo tipo), a tela diz "não declara" em
 * vez de repetir uma afirmação que o contrato não faz.
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
  it("país com fonte própria: traduz o código, e mostra o link e a data da consulta", () => {
    const deepseek = PROVEDORES.find((p) => p.id === "deepseek");
    expect(deepseek?.pais, "o catálogo deixou de declarar a China pela DeepSeek").toBe("CN");
    expect(deepseek?.fonteDoPais, "o catálogo deixou de trazer fonte para a DeepSeek").toBeTruthy();

    const el = linha(deepseek!);
    expect(el).toHaveAttribute("data-situacao", "declarado");
    expect(el).toHaveTextContent("Para onde o texto vai: China");
    expect(el).toHaveTextContent("consultada em 12/11/2026");
    // Com fonte por provedor o país é o declarado por ele — não leva a marca de sede.
    expect(el).not.toHaveTextContent("sede do provedor");
    const fonte = screen.getByRole("link", { name: "fonte: política do provedor" });
    expect(fonte).toHaveAttribute("href", deepseek!.fonteDoPais!.url);
  });

  it("país declarado sem fonte por provedor: mostra o NOME traduzido, não o código", () => {
    // A declaração destes é a do catálogo, datada em `CONSULTA_DOS_PAISES_EM` e
    // impressa pela cláusula 9 — a linha não inventa link nem data.
    const anthropic = PROVEDORES.find((p) => p.id === "anthropic");
    expect(anthropic?.pais).toBe("US");

    const el = linha(anthropic!);
    expect(el).toHaveAttribute("data-situacao", "declarado");
    // Sem fonte própria o código é a SEDE de quem recebe, não a região de
    // processamento — a tela diz isso em vez de imprimir o país como declarado.
    expect(el).toHaveTextContent("Para onde o texto vai: Estados Unidos (sede do provedor)");
    // Código cru não vaza para a tela: quem lê é o operador, não a cláusula.
    expect(el).not.toHaveTextContent(/\bUS\b/);
    expect(screen.queryByRole("link", { name: "fonte: política do provedor" })).toBeNull();
  });

  it("provedor que não declara país: aparece o aviso, em vez de a linha sumir", () => {
    const requesty = PROVEDORES.find((p) => p.id === "requesty");
    expect(requesty?.pais).toBe("desconhecido");

    const el = linha(requesty!);
    expect(el).toHaveAttribute("data-situacao", "desconhecido");
    expect(el).toHaveTextContent("O provedor não declara o país; consulte a política dele");
  });

  it("modelo no servidor do operador: diz que nada sai da instalação", () => {
    const el = linha({ pais: "operador", fonteDoPais: null });
    expect(el).toHaveAttribute("data-situacao", "operador");
    expect(el).toHaveTextContent("Neste servidor — nada sai da instalação");
  });

  it("endpoint próprio configurado vence o catálogo: quem escolheu o endereço sabe onde ele fica", () => {
    const deepseek = PROVEDORES.find((p) => p.id === "deepseek");
    const el = linha(deepseek!, "https://meu-gateway.exemplo.com/v1");
    expect(el).toHaveAttribute("data-situacao", "endereco_proprio");
    expect(el).toHaveTextContent("Endereço definido por você — o CRM não sabe onde ele fica");
    expect(el).not.toHaveTextContent("China");
  });

  it("valor fora do vocabulário não é país: a tela cai para o desconhecido declarado", () => {
    // É o formato que o campo aceitava antes do #4520 (texto livre) — e o que um
    // consumidor que não passou pelo tipo ainda consegue entregar.
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
      expect(el).toHaveTextContent("Para onde o texto vai:");
      // E o código do catálogo nunca aparece cru para o operador.
      expect(el).not.toHaveTextContent(/:\s*(US|CN|UE)\b/);
      unmount();
    }
  });
});
