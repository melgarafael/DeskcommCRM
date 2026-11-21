/**
 * REGISTRAR VENDA e a seção VENDAS do negócio.
 *
 *  1. a janela abre com a data de HOJE, recusa valor vazio, e manda valor em
 *     centavos, data, tags normalizadas e a observação;
 *  2. a seção lista as vendas, soma o total e apaga só depois de confirmar;
 *  3. somente leitura: sem botão de registrar nem lixeira;
 *  4. o "+" do card abre a janela sem subir o clique para o card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const registrar = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({})), isPending: false }));
const apagar = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
vi.mock("@/hooks/vendas/useVendasRegistradas", () => ({
  useRegistrarVenda: () => registrar,
  useApagarVenda: () => apagar,
  useVendasDoNegocio: vi.fn(),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useVendasDoNegocio } from "@/hooks/vendas/useVendasRegistradas";

import { BotaoRegistrarVenda } from "./BotaoRegistrarVenda";
import { RegistrarVendaDialog, hojeNoAparelho, tagsDoTexto } from "./RegistrarVendaDialog";
import { VendasDoNegocio } from "./VendasDoNegocio";

const LEAD = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 20, 15, 0, 0)); // 20/11/2026, hora local
});
afterEach(() => vi.useRealTimers());

describe("tags e data", () => {
  it("tags do texto saem normalizadas e sem repetição", () => {
    expect(tagsDoTexto(" Atacado, recompra ,ATACADO,, ")).toEqual(["atacado", "recompra"]);
  });

  it("hoje é o dia do aparelho em AAAA-MM-DD", () => {
    expect(hojeNoAparelho(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("RegistrarVendaDialog", () => {
  it("abre com a data de hoje e não salva sem valor", () => {
    render(<RegistrarVendaDialog open onOpenChange={() => {}} leadId={LEAD} />);

    expect((screen.getByLabelText("Data da venda") as HTMLInputElement).value).toBe("2026-11-20");
    expect((screen.getByTestId("salvar-venda") as HTMLButtonElement).disabled).toBe(true);
  });

  it("manda valor em centavos, data, tags normalizadas e observação", async () => {
    const fechar = vi.fn();
    render(<RegistrarVendaDialog open onOpenChange={fechar} leadId={LEAD} />);

    fireEvent.change(screen.getByLabelText("Valor"), { target: { value: "180,50" } });
    fireEvent.change(screen.getByLabelText("Data da venda"), { target: { value: "2026-11-18" } });
    fireEvent.change(screen.getByLabelText("Tags (separe por vírgula)"), { target: { value: "Atacado, recompra" } });
    fireEvent.change(screen.getByLabelText("Observação (opcional)"), { target: { value: "Kit enxoval" } });
    expect(screen.getByTestId("previa-das-tags").textContent).toBe("atacadorecompra");
    fireEvent.click(screen.getByTestId("salvar-venda"));

    await waitFor(() => expect(registrar.mutateAsync).toHaveBeenCalled());
    expect(registrar.mutateAsync).toHaveBeenCalledWith({
      lead_id: LEAD,
      valor_cents: 18_050,
      data: "2026-11-18",
      tags: ["atacado", "recompra"],
      observacao: "Kit enxoval",
    });
    await waitFor(() => expect(fechar).toHaveBeenCalledWith(false));
  });
});

describe("VendasDoNegocio", () => {
  const vendas = [
    { id: "v1", lead_id: LEAD, contact_id: "c1", valor_cents: 18_000, currency: "BRL", data: "2026-11-20", tags: ["atacado"], observacao: "Kit", created_by: "u1", created_at: "" },
    { id: "v2", lead_id: LEAD, contact_id: "c1", valor_cents: 12_000, currency: "BRL", data: "2026-11-15", tags: [], observacao: null, created_by: "u1", created_at: "" },
  ];

  it("lista as vendas, soma o total e apaga só depois de confirmar", () => {
    vi.mocked(useVendasDoNegocio).mockReturnValue({ data: vendas, isLoading: false, isError: false } as never);
    const confirmar = vi.spyOn(window, "confirm");
    render(<VendasDoNegocio leadId={LEAD} moeda="BRL" />);

    expect(screen.getAllByTestId("venda-registrada")).toHaveLength(2);
    expect(screen.getByTestId("total-das-vendas").textContent).toMatch(/2 venda\(s\).*R\$.300,00/);

    confirmar.mockReturnValueOnce(false);
    fireEvent.click(screen.getAllByLabelText("Apagar venda")[0]!);
    expect(apagar.mutate).not.toHaveBeenCalled();

    confirmar.mockReturnValueOnce(true);
    fireEvent.click(screen.getAllByLabelText("Apagar venda")[0]!);
    expect(apagar.mutate).toHaveBeenCalledWith("v1", expect.anything());
  });

  it("somente leitura: sem registrar e sem lixeira", () => {
    vi.mocked(useVendasDoNegocio).mockReturnValue({ data: vendas, isLoading: false, isError: false } as never);
    render(<VendasDoNegocio leadId={LEAD} somenteLeitura />);

    expect(screen.queryByTestId("abrir-registrar-venda")).toBeNull();
    expect(screen.queryByLabelText("Apagar venda")).toBeNull();
  });
});

describe("BotaoRegistrarVenda", () => {
  it("abre a janela e o clique não sobe para o card", () => {
    const cliqueNoCard = vi.fn();
    render(
      <div onClick={cliqueNoCard}>
        <BotaoRegistrarVenda leadId={LEAD} titulo="Dãm Dãm Baby" />
      </div>,
    );

    fireEvent.click(screen.getByTestId("card-registrar-venda"));

    expect(screen.getByTestId("registrar-venda")).toBeTruthy();
    expect(cliqueNoCard).not.toHaveBeenCalled();
  });
});
