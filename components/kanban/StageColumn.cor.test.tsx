import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { DragDropContext } from "@hello-pangea/dnd";

import { StageColumn } from "./StageColumn";
import type { Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

/**
 * A COR DA ETAPA PINTA A COLUNA (#4802 item 2, continuação do #4846).
 *
 * O que se mede é o que chega ao DOM: o fundo e a borda da coluna e do
 * cabeçalho preso levam o tom da etapa; sem cor, nenhum `style` de cor.
 */
vi.mock("./LeadDossier", () => ({ LeadDossier: () => null }));
// Os cards não são o assunto: o total do cabeçalho só precisa dos leads com valor.
vi.mock("./CardsDaColuna", () => ({ CardsDaColuna: () => null }));

function etapa(color: string | null): Stage {
  return { id: "e-1", name: "Curadoria", position: 0, is_won: false, is_lost: false, color } as unknown as Stage;
}

const COM_VALOR = [{ id: "l-1", title: "Proposta", value_cents: 250_000, currency: "BRL" } as unknown as Lead];

function montar(color: string | null, corNaColuna = true, leads: Lead[] = []) {
  return render(
    <DragDropContext onDragEnd={() => {}}>
      <StageColumn stage={etapa(color)} leads={leads} pipelineId="p-1" corNaColuna={corNaColuna} />
    </DragDropContext>,
  );
}

describe("StageColumn com a cor da etapa", () => {
  it("opção ligada e etapa com cor: coluna e cabeçalho ganham o tom pastel e a borda", () => {
    const { container } = montar("#ab4aba");
    const coluna = container.querySelector<HTMLElement>("[data-etapa-do-quadro]")!;
    const cabecalho = container.querySelector<HTMLElement>("[data-cabecalho-da-etapa]")!;
    expect(coluna.getAttribute("style")).toContain("color-mix(in srgb, #ab4aba 18%");
    expect(coluna.getAttribute("style")).toContain("color-mix(in srgb, #ab4aba 36%");
    expect(cabecalho.getAttribute("style")).toContain("color-mix(in srgb, #ab4aba 36%");
    expect(cabecalho.firstElementChild!.getAttribute("style")).toContain("color-mix(in srgb, #ab4aba 18%");
  });

  it("com a opção desligada (o padrão), a etapa colorida continua só na bolinha", () => {
    const { container } = montar("#ab4aba", false);
    expect(container.querySelector("[data-etapa-do-quadro]")!.getAttribute("style") ?? "").not.toContain("color-mix");
    expect(container.querySelector("[data-cabecalho-da-etapa]")!.getAttribute("style") ?? "").not.toContain("color-mix");
    const bolinha = container.querySelector<HTMLElement>("[data-cabecalho-da-etapa] span[aria-hidden]")!;
    expect(bolinha.style.backgroundColor).toBe("rgb(171, 74, 186)");
  });

  it("etapa sem cor: nenhum estilo de cor, a coluna fica como hoje", () => {
    const { container } = montar(null);
    const coluna = container.querySelector<HTMLElement>("[data-etapa-do-quadro]")!;
    expect(coluna.getAttribute("style") ?? "").not.toContain("color-mix");
    expect(container.querySelector("[data-cabecalho-da-etapa]")!.getAttribute("style") ?? "").not.toContain("color-mix");
  });

  // Prova de tela do #4976: no tema escuro, o cinza de apoio sobre o fundo colorido
  // ficava abaixo de 4,5:1 (2,77 na etapa amarela). Colorida, a linha do total usa a
  // cor de texto principal; sem a opção, segue a de apoio, como hoje.
  it("o total da etapa usa o texto principal na coluna colorida, e o de apoio fora dela", () => {
    const linhaDoTotal = (c: HTMLElement) =>
      [...c.querySelectorAll<HTMLElement>("[data-cabecalho-da-etapa] div")].filter((d) => d.textContent?.includes("R$")).at(-1)!;
    const colorida = linhaDoTotal(montar("#ffd60a", true, COM_VALOR).container);
    expect(colorida.className).toMatch(/\btext-text\b/);
    expect(colorida.className).not.toContain("text-text-muted");
    const desligada = linhaDoTotal(montar("#ffd60a", false, COM_VALOR).container);
    expect(desligada.className).toContain("text-text-muted");
  });

  it("cor inválida no dado não vira CSS", () => {
    const { container } = montar("#ab4aba; background: url(x)");
    const coluna = container.querySelector<HTMLElement>("[data-etapa-do-quadro]")!;
    expect(coluna.getAttribute("style") ?? "").not.toContain("url(");
    expect(coluna.getAttribute("style") ?? "").not.toContain("color-mix");
  });
});
