/**
 * AS ETAPAS DO FUNIL RECOLHIDAS, UM FUNIL ABERTO POR VEZ (#4083).
 *
 * A tela empilhava um card por funil com a tabela de etapas e o mapeamento do
 * agente SEMPRE visíveis: com os dez funis do relato da comunidade, achar um
 * deles virava rolagem às cegas. O que estes casos trancam:
 *
 *   - todo funil nasce RECOLHIDO, mostrando só nome e slug;
 *   - abrir um fecha o anterior (acordeão de verdade, não N botões soltos);
 *   - recolher NÃO desmonta o corpo — é o mesmo cuidado do editor do #3176:
 *     desmontar apagaria em silêncio a etapa editada e não salva;
 *   - a âncora `#etapas-<id>` / `#mapeamento-<id>` abre o card certo, inclusive
 *     depois de recarregar a página com o hash na barra de endereço.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
// As seções irmãs falam com a API; aqui o que se mede é quem está ABERTO.
vi.mock("./_stages", () => ({
  StagesSection: ({ pipelineId }: { pipelineId: string }) => (
    <div data-testid={`corpo-${pipelineId}`}>etapas de {pipelineId}</div>
  ),
  ancoraDasEtapas: (pipelineId: string) => `etapas-${pipelineId}`,
}));
vi.mock("./_mapping", () => ({
  AgentMappingSection: ({ pipelineId }: { pipelineId: string }) => (
    <div data-testid={`mapeamento-${pipelineId}`}>mapeamento de {pipelineId}</div>
  ),
  ancoraDoMapeamento: (pipelineId: string) => `mapeamento-${pipelineId}`,
}));

import { PipelinesClient, type PipelineRow } from "./_client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function funil(id: string, name: string): PipelineRow {
  return { id, name, slug: name.toLowerCase(), vocabulary: null, settings: null };
}

function renderizar(): void {
  render(
    <PipelinesClient
      pipelines={[funil(A, "Vendas"), funil(B, "Suporte")]}
      podeEditarConfig={false}
    />,
  );
}

/** O botão do cabeçalho de um funil — o que abre e fecha o card. */
function cabecalho(nome: RegExp): HTMLElement {
  return screen.getByRole("button", { name: nome });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/app/settings/tenant/pipelines");
});

describe("CRM › Etapas do funil recolhe cada funil (#4083)", () => {
  it("todo funil nasce recolhido: só o cabeçalho, nenhuma tabela à vista", () => {
    renderizar();

    expect(cabecalho(/Vendas/)).toHaveAttribute("aria-expanded", "false");
    expect(cabecalho(/Suporte/)).toHaveAttribute("aria-expanded", "false");
    // `role=region` é o painel aberto do acordeão. Nenhum: a tela abre fechada.
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });

  it("abrir um funil fecha o que estava aberto — um por vez", () => {
    renderizar();

    fireEvent.click(cabecalho(/Vendas/));
    expect(cabecalho(/Vendas/)).toHaveAttribute("aria-expanded", "true");
    expect(cabecalho(/Suporte/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("region")).toHaveLength(1);

    fireEvent.click(cabecalho(/Suporte/));
    expect(cabecalho(/Suporte/)).toHaveAttribute("aria-expanded", "true");
    expect(cabecalho(/Vendas/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("region")).toHaveLength(1);
  });

  it("recolher ESCONDE o corpo, não desmonta — a etapa editada não se perde", () => {
    renderizar();

    fireEvent.click(cabecalho(/Vendas/));
    const corpo = screen.getByTestId(`corpo-${A}`);
    expect(corpo).toBeVisible();

    fireEvent.click(cabecalho(/Vendas/));
    expect(cabecalho(/Vendas/)).toHaveAttribute("aria-expanded", "false");
    // O MESMO nó continua no DOM, agora escondido: estado local (o que foi
    // digitado e não salvo) sobrevive ao recolher.
    expect(screen.getByTestId(`corpo-${A}`)).toBe(corpo);
    expect(corpo).not.toBeVisible();
  });

  it("a âncora do mapeamento abre o card certo depois de recarregar com o hash", () => {
    // Simula o F5 com `#mapeamento-<id>` na barra: quem chega por link direto
    // cai no funil certo, não na página com dez cards fechados.
    window.history.replaceState(null, "", `/app/settings/tenant/pipelines#mapeamento-${B}`);

    renderizar();

    expect(cabecalho(/Suporte/)).toHaveAttribute("aria-expanded", "true");
    expect(cabecalho(/Vendas/)).toHaveAttribute("aria-expanded", "false");
  });

  it("a âncora das etapas também abre o card, e um hash desconhecido não abre nada", () => {
    window.history.replaceState(null, "", `/app/settings/tenant/pipelines#etapas-${A}`);
    const { unmount } = render(
      <PipelinesClient pipelines={[funil(A, "Vendas"), funil(B, "Suporte")]} podeEditarConfig={false} />,
    );
    expect(cabecalho(/Vendas/)).toHaveAttribute("aria-expanded", "true");
    unmount();

    window.history.replaceState(null, "", "/app/settings/tenant/pipelines#ancora-que-nao-existe");
    renderizar();
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });
});
