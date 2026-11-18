/**
 * A LISTA DE FUNIS EM CONFIGURAÇÕES GANHA BUSCA (#4593).
 *
 * Com muitos funis a tela «Etapas do funil» já nasce recolhida (#4083), mas
 * achar um funil ainda pedia ler a lista inteira. A caixa de busca segue o
 * jeito da lista de Agentes; a régua é `funisQueCasam`
 * (`lib/pipelines/filtrar-funis.ts`), testada à parte sem DOM.
 *
 * O que só a tela prova: o funil fora da busca é ESCONDIDO, não desmontado. O
 * editor do funil guarda rascunho não salvo, e a busca não pode apagá-lo em
 * silêncio — a mesma promessa de «recolher só esconde» (#3176).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
// As duas seções do corpo falam com a API; este arquivo é sobre a BUSCA.
vi.mock("./_stages", () => ({
  StagesSection: () => null,
  ancoraDasEtapas: () => "etapas",
}));
vi.mock("./_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { PipelinesClient, type PipelineRow } from "./_client";

function funil(n: number, name: string, slug: string): PipelineRow {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name,
    slug,
    vocabulary: null,
    settings: { fields: [{ key: "origem", label: "Origem", type: "text" }] },
  };
}

const PROSPECCAO = funil(1, "Prospecção (Site)", "prospeccao-site");
const POS_VENDA = funil(2, "Pós-venda", "pos-venda");
const LOCACAO = funil(3, "Locação", "aluguel");

const cardDe = (p: PipelineRow) => screen.getByTestId(`card-do-funil-${p.id}`);
const busca = () => screen.getByRole("textbox", { name: "Buscar funis" });
const digitar = (termo: string) => fireEvent.change(busca(), { target: { value: termo } });

function montar(pipelines: PipelineRow[] = [PROSPECCAO, POS_VENDA, LOCACAO]) {
  return render(<PipelinesClient pipelines={pipelines} podeEditarConfig />);
}

beforeEach(() => {
  // A âncora `#etapas-<id>` abre um funil na montagem; a tela daqui nasce sem ela.
  window.history.replaceState(null, "", "/");
});

describe("Configurações › Funis: a busca da lista", () => {
  it("sem termo, todos os funis à vista", () => {
    montar();
    for (const p of [PROSPECCAO, POS_VENDA, LOCACAO]) expect(cardDe(p).hidden).toBe(false);
  });

  it("acha pelo nome sem acento, e esconde o resto", () => {
    montar();
    digitar("prospeccao");
    expect(cardDe(PROSPECCAO).hidden).toBe(false);
    expect(cardDe(POS_VENDA).hidden).toBe(true);
    expect(cardDe(LOCACAO).hidden).toBe(true);

    digitar("POS-VENDA");
    expect(cardDe(POS_VENDA).hidden).toBe(false);
    expect(cardDe(PROSPECCAO).hidden).toBe(true);
  });

  it("acha pelo endereço que o cartão mostra embaixo do nome", () => {
    montar();
    digitar("aluguel");
    expect(cardDe(LOCACAO).hidden).toBe(false);
    expect(cardDe(PROSPECCAO).hidden).toBe(true);
  });

  it("termo que não existe mostra o aviso, e apagar o termo devolve a lista", () => {
    montar();
    digitar("financeiro");
    expect(screen.getByText("Nenhum funil corresponde à busca.")).toBeTruthy();
    for (const p of [PROSPECCAO, POS_VENDA, LOCACAO]) expect(cardDe(p).hidden).toBe(true);

    digitar("");
    expect(screen.queryByText("Nenhum funil corresponde à busca.")).toBeNull();
    for (const p of [PROSPECCAO, POS_VENDA, LOCACAO]) expect(cardDe(p).hidden).toBe(false);
  });

  it("o funil que a busca esconde não perde o que foi editado e ainda não salvo", () => {
    montar();
    fireEvent.click(screen.getByTestId(`abrir-editor-${PROSPECCAO.id}`));
    const rotulo = () => screen.getByLabelText("Rótulo do campo 1") as HTMLInputElement;
    fireEvent.change(rotulo(), { target: { value: "Origem EDITADA" } });

    // A busca esconde o funil em edição...
    digitar("locacao");
    expect(cardDe(PROSPECCAO).hidden).toBe(true);
    // ...e ao voltar ele está como a pessoa deixou: o editor não desmontou.
    digitar("");
    expect(cardDe(PROSPECCAO).hidden).toBe(false);
    expect(rotulo().value).toBe("Origem EDITADA");
  });

  it("com um funil só não há busca: a tela fica como era", () => {
    montar([PROSPECCAO]);
    expect(screen.queryByRole("textbox", { name: "Buscar funis" })).toBeNull();
    expect(cardDe(PROSPECCAO).hidden).toBe(false);
  });
});
