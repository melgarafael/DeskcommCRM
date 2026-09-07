import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DetalheDoCompromisso } from "@/components/agenda/DetalheDoCompromisso";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));
const initial = {
  id: "appointment",
  title: "Consulta",
  starts_at: "2020-01-01T12:00:00Z",
  ends_at: "2020-01-01T13:00:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  revision: 1,
  contact_id: null,
  conversation_id: null,
  outcome_source_kind: null,
  outcome_recorded_at: null,
  recovery: null,
  evidence_messages: [],
};
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  api.get.mockResolvedValue({ data: initial });
  api.delete.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  client.clear();
});
function open(locale = "pt-BR") {
  render(
    <IdiomaProvider locale={locale}>
      <QueryClientProvider client={client}>
        <DetalheDoCompromisso id="appointment" onClose={() => {}} />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
  return screen.findByLabelText(
    locale === "es" ? "Motivo de cancelación" : "Motivo do cancelamento",
  );
}
it.each([
  {
    locale: "pt-BR",
    time_zone: "America/Sao_Paulo",
    interval: "29 de ago. de 2026, 23:30 – 30 de ago. de 2026, 00:30",
    recorded: "Presença registrada pela equipe: 30 de ago. de 2026, 01:45",
  },
  {
    locale: "es",
    time_zone: "America/Sao_Paulo",
    interval: "29 ago 2026, 23:30 – 30 ago 2026, 0:30",
    recorded: "Asistencia registrada por el equipo: 30 ago 2026, 1:45",
  },
  {
    locale: "pt-BR",
    time_zone: "Asia/Tokyo",
    interval: "30 de ago. de 2026 11:30 – 12:30",
    recorded: "Presença registrada pela equipe: 30 de ago. de 2026, 13:45",
  },
])(
  "datas em $locale usam $time_zone, inclusive o dia final e o registro",
  async ({ locale, time_zone, interval, recorded }) => {
    api.get.mockResolvedValue({
      data: {
        ...initial,
        starts_at: "2026-08-30T02:30:00Z",
        ends_at: "2026-08-30T03:30:00Z",
        time_zone,
        outcome_recorded_at: "2026-08-30T04:45:00Z",
      },
    });
    await open(locale);
    // Calendário e relógio esperados são literais, sem usar o formatter como oráculo.
    expect(screen.getByTestId("compromisso-horario").textContent?.replace(/\s+/g, " ")).toBe(
      interval,
    );
    expect(screen.getByText(recorded)).toBeTruthy();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  },
);
it("polling atualiza dados mas bloqueia rascunho iniciado na revisão anterior", async () => {
  const reason = await open();
  fireEvent.change(reason, { target: { value: "Não poderei atender" } });
  act(() => client.setQueryData(["agenda", "detalhe", "appointment"], { ...initial, revision: 2 }));
  expect((await screen.findByRole("alert")).textContent).toContain("O compromisso mudou");
  const cancel = screen.getByRole("button", { name: "Cancelar agendamento" }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);
  fireEvent.click(cancel);
  expect(api.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Descartar rascunho e revisar" }));
  expect((reason as HTMLInputElement).value).toBe("");
  fireEvent.change(reason, { target: { value: "Revisei os novos dados" } });
  fireEvent.click(cancel);
  await waitFor(() =>
    expect(api.delete).toHaveBeenCalledWith("/api/v1/agenda/agendamentos", {
      id: "appointment",
      revision: 2,
      reason: "Revisei os novos dados",
    }),
  );
});
it("CAS recusado mantém decisão bloqueada após refetch até revisão explícita", async () => {
  const reason = await open();
  fireEvent.change(reason, { target: { value: "Rascunho antigo" } });
  api.get.mockResolvedValue({ data: { ...initial, revision: 2 } });
  api.delete.mockRejectedValueOnce(new Error("revision_conflict"));
  fireEvent.click(screen.getByRole("button", { name: "Cancelar agendamento" }));
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(client.getQueryData(["agenda", "detalhe", "appointment"])).toMatchObject({
      revision: 2,
    }),
  );
  expect((reason as HTMLInputElement).value).toBe("Rascunho antigo");
  expect(
    (screen.getByRole("button", { name: "Cancelar agendamento" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(api.delete).toHaveBeenCalledOnce();
  expect(api.delete.mock.calls[0]?.[1]).toMatchObject({ revision: 1 });
});
it("resultado assíncrono sem mudança de revisão conserva intenção válida", async () => {
  const reason = await open();
  fireEvent.change(reason, { target: { value: "Decisão atual" } });
  act(() =>
    client.setQueryData(["agenda", "detalhe", "appointment"], {
      ...initial,
      recovery: {
        result: "other_flow",
        enrollment_id: null,
        invalidated_at: null,
        enrollment_status: null,
        cancel_reason: null,
      },
    }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancelar agendamento" }));
  await waitFor(() =>
    expect(api.delete.mock.calls[0]?.[1]).toMatchObject({ revision: 1, reason: "Decisão atual" }),
  );
});
