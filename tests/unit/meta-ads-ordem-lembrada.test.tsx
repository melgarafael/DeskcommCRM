/**
 * A ORDEM ESCOLHIDA NA TABELA DE CAMPANHAS FICA LEMBRADA (#4480).
 *
 * Hoje o critério mora num `useState` que nasce em `ORDEM_PADRAO`: desmontar e
 * montar de novo a tabela — o que acontece a cada troca de aba ou recarga —
 * devolve "Mais recentes" para quem prefere "Ativas primeiro".
 *
 * A memória é do NAVEGADOR (`localStorage`), como a do menu lateral e a dos
 * filtros do Inbox: é escolha de leitura, não dado do sistema. O que estes
 * casos prendem é o comportamento de ponta a ponta: sobrevive ao remonte,
 * valor inválido cai no padrão e storage que lança não quebra a tela.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TabelaDeCampanhas } from "@/app/app/ads/meta/_components/TabelaDeCampanhas";
import { lerOrdemLembrada } from "@/lib/plataformas-de-anuncio/meta/ordem-lembrada";
import { ORDEM_PADRAO } from "@/lib/plataformas-de-anuncio/meta/tabela-de-campanhas";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const CHAVE = "meta-ads:ordem-das-campanhas:v1";

function linha(campanhaId: string, criadaEm: string, veiculacao = "ACTIVE"): LinhaDeCampanha {
  return {
    campanhaId,
    nome: campanhaId,
    status: "ACTIVE",
    veiculacao,
    objetivo: "OUTCOME_LEADS",
    criadaEm,
    iniciadaEm: criadaEm,
    resultado: { valor: null, custoPorResultado: null, indicador: null },
    gasto: 10,
    impressoes: 100,
    alcance: 80,
    cpm: 5,
    ctr: 1,
    connectRate: null,
    frequencia: 1.2,
    cpc: 0.5,
    hookRate: null,
    thruPlays: null,
  };
}

const LINHAS = [
  linha("Captação: janeiro", "2024-01-09T11:00:00+0000", "PAUSED"),
  linha("Engajamento: Astra Mídia", "2026-08-14T09:31:10+0000"),
];

function seletor(): HTMLSelectElement {
  return screen.getByLabelText("Ordenar por") as HTMLSelectElement;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("a ordenação escolhida é lembrada", () => {
  it("escolher `Ativas primeiro`, desmontar e montar de novo mantém a escolha", () => {
    const primeira = render(<TabelaDeCampanhas linhas={LINHAS} moeda="BRL" />);
    fireEvent.change(seletor(), { target: { value: "status" } });
    expect(seletor().value).toBe("status");
    primeira.unmount();

    render(<TabelaDeCampanhas linhas={LINHAS} moeda="BRL" />);
    expect(seletor().value).toBe("status");
  });

  it("sem nada salvo, abre na ordem padrão", () => {
    render(<TabelaDeCampanhas linhas={LINHAS} moeda="BRL" />);
    expect(seletor().value).toBe("mais_recentes");
    // Nada escolhido, nada gravado: a primeira visita não escreve preferência.
    expect(window.localStorage.getItem(CHAVE)).toBeNull();
  });

  it("valor desconhecido ou corrompido no storage cai na ordem padrão", () => {
    for (const lixo of ["mais_urgentes", "", "{", "null"]) {
      window.localStorage.setItem(CHAVE, lixo);
      const vista = render(<TabelaDeCampanhas linhas={LINHAS} moeda="BRL" />);
      expect(seletor().value, `valor salvo: ${JSON.stringify(lixo)}`).toBe("mais_recentes");
      vista.unmount();
    }
  });

  it("storage que lança não quebra a tela: a troca vale na sessão", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    render(<TabelaDeCampanhas linhas={LINHAS} moeda="BRL" />);
    expect(seletor().value).toBe("mais_recentes");

    fireEvent.change(seletor(), { target: { value: "mais_antigas" } });
    expect(seletor().value).toBe("mais_antigas");
  });

  /**
   * As duas provas abaixo fecham o que o DOM ESCONDE.
   *
   * O `<select>` mente por omissão: um `value` que não casa com nenhuma
   * `option` não fica visível — o navegador exibe a primeira, e
   * `ordenarCampanhas` também cai no padrão. Por isso ler o valor errado no
   * inicializador do estado, ou deixar de validar o que veio do storage, passa
   * despercebido pelos quatro casos acima. A prova do primeiro render é de
   * SERVIDOR (não há `useEffect` nela) e a do contrato é direta na função.
   */

  it("o primeiro render é o do servidor: ORDEM_PADRAO, sem tocar o storage", () => {
    // Há uma preferência salva — e mesmo assim o HTML servido nasce no padrão.
    window.localStorage.setItem(CHAVE, "status");
    const obter = vi.spyOn(Storage.prototype, "getItem");

    const html = renderToStaticMarkup(<TabelaDeCampanhas linhas={LINHAS} moeda="BRL" />);

    expect(html).toContain('<option value="mais_recentes" selected=""');
    expect(html).not.toContain('<option value="status" selected=""');
    // Ler no inicializador do `useState` faria o HTML do servidor divergir do
    // primeiro render do cliente — e o storage só pode ser consultado depois.
    expect(obter).not.toHaveBeenCalled();
  });

  it("o contrato da leitura cai no padrão em valor desconhecido, corrompido e storage que lança", () => {
    const storage = window.localStorage;
    for (const lixo of ["mais_urgentes", "MAIS_RECENTES", "status ", "", "{", "null"]) {
      storage.setItem(CHAVE, lixo);
      expect(lerOrdemLembrada(storage), `valor salvo: ${JSON.stringify(lixo)}`).toBe(
        ORDEM_PADRAO,
      );
    }

    // A validação não pode ser "ignorar tudo": o critério conhecido continua valendo.
    storage.setItem(CHAVE, "status");
    expect(lerOrdemLembrada(storage)).toBe("status");

    // Storage bloqueado na LEITURA (`SecurityError`) e a ausência de storage.
    const bloqueado: Pick<Storage, "getItem" | "setItem"> = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {},
    };
    expect(lerOrdemLembrada(bloqueado)).toBe(ORDEM_PADRAO);
    expect(lerOrdemLembrada(null)).toBe(ORDEM_PADRAO);
  });
});
