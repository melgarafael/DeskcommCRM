import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiThemeProvider } from "@/components/ui-themes/Provider";
import { uiThemePackageSchema } from "@/lib/ui-themes/contracts";
import { padrao } from "@/ui-themes/padrao/definition";
import { HistoricoDaAgenda, FiltrosDoHistorico, type AbaDoHistorico } from "./HistoricoDaAgenda";
import { ListaDoPeriodo } from "./ListaDoPeriodo";
import type { Agendamento } from "./tipos";

afterEach(cleanup);
const now = new Date("2026-10-21T12:00:00Z");
function item(id: string, situacao: Agendamento["situacao"], time: string): Agendamento {
  return {
    id,
    situacao,
    titulo: id,
    responsavelId: "user-a",
    origem: "ui",
    comeca: time,
    termina: new Date(Date.parse(time) + 1800000).toISOString(),
  };
}
const rows = [
  item("pendente", "pending", "2026-10-21T13:00:00Z"),
  item("futuro", "confirmed", "2026-10-21T14:00:00Z"),
  item("passado", "confirmed", "2026-10-21T10:00:00Z"),
  item("cancelado", "cancelled", "2026-10-21T15:00:00Z"),
];
const demo = uiThemePackageSchema.parse({
  ...padrao,
  id: "calendar-demo",
  title: "Calendar demo",
  areas: { calendar: { contractVersion: 1, configuration: { historyAllFirst: true } } },
});
describe("calendar presentation preserves native actions", () => {
  it("opens Todos and keeps actions appropriate to each row, including disabled permissions", () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const completed = vi.fn();
    render(
      <UiThemeProvider theme={{ package: demo, values: {}, fallback: null, requestedId: demo.id }}>
        <HistoricoDaAgenda
          agendamentos={rows}
          pessoas={[]}
          agora={now}
          fuso="America/Sao_Paulo"
          onConfirmar={confirm}
          onCancelar={cancel}
          onRealizado={completed}
        />
      </UiThemeProvider>,
    );
    expect(screen.getByRole("tab", { name: /Todos/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByTestId("confirmar-pendente"));
    expect(confirm).toHaveBeenCalledWith("pendente");
    fireEvent.click(screen.getByTestId("cancelar-futuro"));
    expect(cancel).toHaveBeenCalledWith("futuro");
    expect(screen.getByTestId("remarcar-futuro")).toBeDisabled();
    expect(within(screen.getByTestId("linha-cancelado")).queryAllByRole("button")).toHaveLength(0);
    expect(
      within(screen.getByTestId("linha-passado")).queryByRole("button", { name: "Confirmar" }),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("aba-aguardando"));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByTestId("linha-pendente")).toBeVisible();
  });
  it("Padrão retains Próximos and its four tabs", () => {
    render(
      <HistoricoDaAgenda agendamentos={rows} pessoas={[]} agora={now} fuso="America/Sao_Paulo" />,
    );
    expect(screen.getByRole("tab", { name: /Próximos/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });
  it("mobile period groups by organization time zone and keeps external occupancy read only", () => {
    const open = vi.fn();
    const external = {
      ...item("externo", "confirmed", "2026-10-22T01:30:00Z"),
      origem: "google_sync" as const,
    };
    render(<ListaDoPeriodo items={[external, rows[1]!]} fuso="America/Sao_Paulo" onOpen={open} />);
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /futuro/ }));
    expect(open).toHaveBeenCalledWith("futuro");
    expect(screen.getByRole("button", { name: /Ocupado na agenda do Google/ })).toBeDisabled();
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("projects the same history filters above the grid without replacing grid or action callbacks", () => {
    const confirm = vi.fn();
    function Projected() {
      const [aba, setAba] = useState<AbaDoHistorico>("todos");
      return (
        <>
          <FiltrosDoHistorico agendamentos={rows} agora={now} aba={aba} onChange={setAba} />
          <section aria-label="Grade preservada">ocupação preservada</section>
          <HistoricoDaAgenda
            agendamentos={rows}
            pessoas={[]}
            agora={now}
            fuso="America/Sao_Paulo"
            aba={aba}
            ocultarFiltros
            onConfirmar={confirm}
          />
        </>
      );
    }
    render(
      <UiThemeProvider theme={{ package: demo, values: {}, fallback: null, requestedId: demo.id }}>
        <Projected />
      </UiThemeProvider>,
    );
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(screen.getByRole("tab", { name: /Aguardando confirmação/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByTestId("linha-pendente")).toBeVisible();
    fireEvent.click(screen.getByTestId("confirmar-pendente"));
    expect(confirm).toHaveBeenCalledWith("pendente");
    fireEvent.click(screen.getByRole("tab", { name: /Cancelados/ }));
    expect(screen.getByTestId("linha-cancelado")).toBeVisible();
    expect(within(screen.getByTestId("linha-cancelado")).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Grade preservada" })).toHaveTextContent(
      "ocupação preservada",
    );
    fireEvent.click(screen.getByRole("tab", { name: /Todos/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });
});
