/**
 * O painel da meta no Desempenho (issue #3025, fatia 1).
 *
 * O que esta tela passou a responder: "este mês a empresa quer 40 vendas
 * ganhas; já fez quantas, está em quantos por cento e faltam quantas?" — os
 * QUATRO números. Antes dela só havia o realizado, e percentual sem alvo não
 * existe: a comparação era de cabeça, mês a mês.
 *
 * O painel recebe o estado pronto (carregando/erro/vazio/ok) de quem busca, e é
 * por isso que este arquivo consegue medir os quatro desfechos sem banco e sem
 * mock de rede. O que ele cobra, em cada um:
 *   · nenhum número vira NaN nem some atrás de um traço mudo;
 *   · "sem meta" EXPLICA e oferece a porta do cadastro — nunca um 0 fingindo
 *     medição (um 0 diria "realizou nada", que é uma afirmação falsa);
 *   · o caso atingido não mostra falta negativa e a barra não passa de 100%.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

import { MetaDoMesPanel, type MetaDaEmpresa } from "@/app/app/metrics/_components/MetaDoMesPanel";

afterEach(cleanup);

const EMPRESA: MetaDaEmpresa = {
  id: "m1",
  escopo: "empresa",
  pipeline_id: null,
  pipeline_nome: null,
  alvo: 10,
  realizado: 3,
  percentual: 30,
  falta: 7,
  atingida: false,
};

function comIdioma(no: ReactNode, locale: "pt-BR" | "es" = "pt-BR") {
  return render(createElement(IdiomaProvider, { locale, children: no }));
}

function renderizar(props: Partial<Parameters<typeof MetaDoMesPanel>[0]> = {}) {
  return render(
    createElement(MetaDoMesPanel, {
      estado: "ok",
      periodo: "2026-09-01",
      metas: [EMPRESA],
      podeConfigurar: true,
      ...props,
    } as Parameters<typeof MetaDoMesPanel>[0]),
  );
}

describe("MetaDoMesPanel", () => {
  it("mostra os quatro números: realizado, alvo, percentual e quanto falta", () => {
    const { container } = renderizar();
    expect(container.querySelector('[data-meta="realizado"]')?.textContent).toBe("3");
    expect(container.querySelector('[data-meta="alvo"]')?.textContent).toBe("10");
    expect(container.querySelector('[data-meta="percentual"]')?.textContent).toBe("30%");
    expect(container.querySelector('[data-meta="falta"]')?.textContent).toBe("7");
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).toContain("09/2026");
  });

  it("a barra desenha o percentual — o mesmo desenho do card de funil", () => {
    const { container } = renderizar();
    const barra = container.querySelector('[data-meta="barra"]') as HTMLElement | null;
    expect(barra).not.toBeNull();
    expect(barra!.style.width).toBe("30%");
  });

  it("meta atingida: percentual acima de 100, falta zero e a barra não passa de 100%", () => {
    const { container } = renderizar({
      metas: [{ ...EMPRESA, alvo: 2, realizado: 3, percentual: 150, falta: 0, atingida: true }],
    });
    expect(container.querySelector('[data-meta="percentual"]')?.textContent).toBe("150%");
    expect(container.querySelector('[data-meta="falta"]')).toBeNull();
    expect(container.textContent).toContain("Meta atingida.");
    const barra = container.querySelector('[data-meta="barra"]') as HTMLElement | null;
    expect(barra!.style.width).toBe("100%");
  });

  it("sem meta: explica e oferece a porta do cadastro (nunca um zero mudo)", () => {
    const { container } = renderizar({ estado: "vazio", metas: [], periodo: null });
    expect(container.textContent).toContain("Nenhuma meta cadastrada para este mês.");
    expect(container.textContent).toContain("Configurações › Meta de vendas");
    expect(container.querySelector('[data-meta="realizado"]')).toBeNull();
    expect(container.querySelector('[data-meta="alvo"]')).toBeNull();
    const porta = screen.getByRole("link", { name: "Definir a meta" });
    expect(porta.getAttribute("href")).toBe("/app/settings/metas");
  });

  it("sem permissão de cadastro: diz quem define a meta, sem mandar para porta nenhuma", () => {
    const { container } = renderizar({
      estado: "vazio",
      metas: [],
      periodo: null,
      podeConfigurar: false,
    });
    expect(screen.queryByRole("link", { name: "Definir a meta" })).toBeNull();
    expect(container.textContent).toContain("Só quem administra a empresa define a meta.");
  });

  it("carregando: a silhueta anuncia a espera em vez de um traço vazio", () => {
    const { container } = renderizar({ estado: "carregando", metas: [], periodo: null });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[data-meta="alvo"]')).toBeNull();
  });

  it("erro de leitura: diz que é falha, não ausência de meta", () => {
    const { container } = renderizar({ estado: "erro", metas: [], periodo: null });
    expect(container.textContent).toContain("falha de leitura");
    expect(container.textContent).not.toContain("Nenhuma meta cadastrada");
  });

  it("meta por funil vem rotulada com o nome do funil", () => {
    const { container } = renderizar({
      metas: [{ ...EMPRESA, escopo: "funil", pipeline_id: "f1", pipeline_nome: "Comercial" }],
    });
    expect(container.textContent).toContain("Comercial");
  });

  it("fala espanhol", () => {
    comIdioma(
      createElement(MetaDoMesPanel, {
        estado: "vazio",
        periodo: null,
        metas: [],
        podeConfigurar: true,
      }),
      "es",
    );
    expect(screen.getByText("Meta del mes")).toBeTruthy();
    expect(screen.getByText(/Ninguna meta registrada/)).toBeTruthy();
  });
});
