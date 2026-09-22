import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { NexusSteps } from "@/components/nexus-ui/forms/NexusSteps";
import { NexusQuantityStepper } from "@/components/nexus-ui/forms/NexusQuantityStepper";
import { NexusConfirmDialog } from "@/components/nexus-ui/forms/NexusConfirmDialog";

describe("NexusSteps", () => {
  const steps = ["Cliente", "Produtos", "Revisão"];

  it("marca a etapa atual com aria-current", () => {
    render(<NexusSteps steps={steps} current={1} reached={1} onGo={() => {}} />);
    const botoes = screen.getAllByRole("button");
    expect(botoes[1]).toHaveAttribute("aria-current", "step");
    expect(botoes[0]).not.toHaveAttribute("aria-current");
  });

  it("não deixa pular para frente pelo indicador", () => {
    render(<NexusSteps steps={steps} current={0} reached={0} onGo={() => {}} />);
    const botoes = screen.getAllByRole("button");
    expect(botoes[2]).toBeDisabled();
  });

  it("volta a passos alcançados", () => {
    const onGo = vi.fn();
    render(<NexusSteps steps={steps} current={2} reached={2} onGo={onGo} />);
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onGo).toHaveBeenCalledWith(0);
  });
});

describe("NexusQuantityStepper", () => {
  it("incrementa, decrementa e respeita o mínimo", () => {
    const onChange = vi.fn();
    const { rerender } = render(<NexusQuantityStepper value={1} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /aumentar/i }));
    expect(onChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: /diminuir/i }));
    expect(onChange).not.toHaveBeenCalledWith(0);

    rerender(<NexusQuantityStepper value={5} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /diminuir/i }));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it("aceita digitação direta com piso no mínimo", () => {
    const onChange = vi.fn();
    render(<NexusQuantityStepper value={2} onChange={onChange} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } });
    expect(onChange).toHaveBeenCalledWith(1);
  });
});

describe("NexusConfirmDialog", () => {
  it("abre pelo próprio botão e confirma com handler ligado", () => {
    const onConfirm = vi.fn();
    render(
      <NexusConfirmDialog
        title="Excluir cliente?"
        description="Não dá para desfazer."
        triggerLabel="Excluir"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));
    expect(screen.getByText("Excluir cliente?")).toBeInTheDocument();
    const botoes = screen.getAllByRole("button", { name: "Excluir" });
    fireEvent.click(botoes[botoes.length - 1]);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
