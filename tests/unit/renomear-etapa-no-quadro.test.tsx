// RENOMEAR A ETAPA NO CABEÇALHO DO QUADRO (extraído do #1738).
//
// O corte de papel é da ROTA (`requireRole("manager")`); a tela só não oferece
// o campo a quem a rota recusaria. O que este arquivo guarda é o contrato do
// campo: salva ao confirmar, com o texto aparado, e nunca salva o que não mudou
// nem o que foi cancelado com Escape.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DragDropContext } from "@hello-pangea/dnd";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/kanban/KanbanCard", () => ({ KanbanCard: () => null }));

import { StageColumn } from "@/components/kanban/StageColumn";
import type { Stage } from "@/lib/kanban/types";

const etapa = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  pipeline_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Proposta",
  position: 1,
  color: null,
} as unknown as Stage;

function montar(podeRenomear: boolean) {
  const onRenomear = vi.fn();
  render(
    <DragDropContext onDragEnd={() => {}}>
      <StageColumn
        stage={etapa}
        leads={[]}
        pipelineId={etapa.pipeline_id}
        podeRenomear={podeRenomear}
        onRenomear={onRenomear}
      />
    </DragDropContext>,
  );
  return onRenomear;
}

const campo = () => screen.getByTestId("nome-etapa-quadro") as HTMLInputElement;

describe("nome da etapa no cabeçalho do quadro", () => {
  it("quem não pode renomear vê só o título, sem campo", () => {
    montar(false);
    expect(screen.getByRole("heading", { name: "Proposta" })).toBeTruthy();
    expect(screen.queryByTestId("nome-etapa-quadro")).toBeNull();
  });

  it("Enter salva o nome aparado", async () => {
    const onRenomear = montar(true);
    await userEvent.clear(campo());
    await userEvent.type(campo(), "  Negociação  {Enter}");
    expect(onRenomear).toHaveBeenCalledExactlyOnceWith("Negociação");
  });

  it("nome igual ou vazio não salva e o campo volta ao nome gravado", async () => {
    const onRenomear = montar(true);
    await userEvent.type(campo(), " {Enter}");
    await userEvent.clear(campo());
    await userEvent.type(campo(), "   {Enter}");
    expect(onRenomear).not.toHaveBeenCalled();
    expect(campo().value).toBe("Proposta");
  });

  it("Escape desfaz sem salvar", async () => {
    const onRenomear = montar(true);
    await userEvent.type(campo(), " fechada{Escape}");
    expect(onRenomear).not.toHaveBeenCalled();
    expect(campo().value).toBe("Proposta");
  });
});
