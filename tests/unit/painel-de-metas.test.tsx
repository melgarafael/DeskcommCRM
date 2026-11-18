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
import type { ValoresDoPeriodo } from "@/lib/metrics/valores-do-periodo";

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

/**
 * As duas parcelas como a rota as devolve (fatia 2, item 1, da #3602).
 * `negocios_com_recorrencia: 0` é o caso da maioria das organizações — e é o
 * que NÃO pode mudar o painel.
 */
function valores(parcial: Partial<ValoresDoPeriodo> = {}): ValoresDoPeriodo {
  return {
    base: "Negócios GANHOS com `closed_at` dentro da janela.",
    moeda: "BRL",
    moeda_mista: false,
    unico: { centavos: 300_000, negocios: 2 },
    recorrente_mensal: { centavos: 50_000, negocios: 1 },
    negocios_com_recorrencia: 1,
    por_moeda: [
      {
        moeda: "BRL",
        unico_centavos: 300_000,
        recorrente_mensal_centavos: 50_000,
        negocios: 2,
        negocios_com_recorrencia: 1,
      },
    ],
    truncado: false,
    nota: null,
    ...parcial,
  };
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

  // ─── As duas parcelas do período (fatia 2, item 1, da #3602) ──────────────

  it("com recorrência: mostra vendido único e recorrência nova lado a lado, nunca somados", () => {
    const { container } = renderizar({ valores: valores() });
    expect(container.querySelector('[data-valores="periodo"]')).not.toBeNull();
    expect(container.querySelector('[data-valores="unico"]')?.textContent).toContain("3.000,00");
    expect(
      container.querySelector('[data-valores="recorrente-mensal"]')?.textContent,
    ).toContain("500,00");
    expect(container.textContent).toContain("Vendido único");
    expect(container.textContent).toContain("Recorrência nova (mensal)");
    expect(container.textContent).toContain("1 negócio com recorrência");
    // A fronteira: 3.500 não existe em lugar nenhum do painel.
    expect(container.textContent).not.toContain("3.500");
    expect(container.textContent).not.toContain("NaN");
  });

  it("organização sem recorrência: nada muda — o bloco das parcelas nem aparece", () => {
    const { container } = renderizar({
      valores: valores({
        unico: { centavos: 300_000, negocios: 1 },
        recorrente_mensal: { centavos: 0, negocios: 0 },
        negocios_com_recorrencia: 0,
        por_moeda: [
          {
            moeda: "BRL",
            unico_centavos: 300_000,
            recorrente_mensal_centavos: 0,
            negocios: 1,
            negocios_com_recorrencia: 0,
          },
        ],
      }),
    });
    expect(container.querySelector('[data-valores="periodo"]')).toBeNull();
    expect(container.textContent).not.toContain("Recorrência nova");
  });

  it("sem o bloco na resposta (org antiga): o painel é exatamente o de antes", () => {
    const { container } = renderizar({ valores: null });
    expect(container.querySelector('[data-valores="periodo"]')).toBeNull();
    expect(container.querySelector('[data-meta="percentual"]')?.textContent).toBe("30%");
  });

  it("leitura parcial: declara que as parcelas são um piso", () => {
    const { container } = renderizar({ valores: valores({ truncado: true }) });
    expect(container.querySelector('[data-valores="piso"]')?.textContent).toContain(
      "Leitura parcial",
    );
  });

  it("moeda diferente: uma linha por moeda, porque moeda não soma", () => {
    const { container } = renderizar({
      valores: valores({
        moeda: null,
        moeda_mista: true,
        unico: { centavos: null, negocios: 2 },
        recorrente_mensal: { centavos: null, negocios: 2 },
        negocios_com_recorrencia: 2,
        por_moeda: [
          {
            moeda: "BRL",
            unico_centavos: 300_000,
            recorrente_mensal_centavos: 50_000,
            negocios: 1,
            negocios_com_recorrencia: 1,
          },
          {
            moeda: "USD",
            unico_centavos: 100_000,
            recorrente_mensal_centavos: 20_000,
            negocios: 1,
            negocios_com_recorrencia: 1,
          },
        ],
      }),
    });
    const linhas = container.querySelectorAll('[data-valores="moeda"]');
    expect(linhas).toHaveLength(2);
    expect(linhas[0]?.textContent).toContain("3.000,00");
    // Cada moeda no SEU formato: dólar sai `$1,000.00`, não `1.000,00`.
    expect(linhas[1]?.textContent).toContain("$1,000.00");
    expect(container.textContent).not.toContain("NaN");
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
