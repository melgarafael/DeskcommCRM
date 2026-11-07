import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AmigoBooking } from "./_booking";
const config = {
  configured: true,
  active: true,
  connection_id: "conn",
  token_last4: null,
  validated_at: null,
  default_place_id: 774,
  timezone: "America/Recife",
  allow_same_day: false,
  months_ahead: 3 as const,
  reminders_enabled: false,
  last_sync_at: null,
  last_error: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("seleciona recursos reais e preserva hora civil, turno e opções de oferta", async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { operation, input } = JSON.parse(String(init.body));
    const values: Record<string, unknown> = {
      places: [{ id: 774, name: "Aflitos" }],
      events: [{ id: 26, name: "Consulta", insurances: "[42]" }],
      insurances: [{ id: 42, name: "Unimed" }],
      insurance_products: [{ id: 13, name: "Ouro" }],
      doctors_available: [{ id: 2437, name: "Gabi" }],
      patient_search: [
        { id: 12, name: "Ana" },
        { id: 13, name: "Dependente" },
      ],
      calendar: [
        {
          date: "2026-11-07",
          slotsByUser: [
            {
              user: { id: 2437, name: "Gabi" },
              slots: [{ id: "slot", start: "08:00", end: "12:00" }],
            },
          ],
        },
      ],
      doctor_dates: input.date
        ? [
            {
              id: "slot",
              user_id: 2437,
              place_id: 774,
              start_date: "2026-11-07T11:00:00Z",
              formatted_start_date: "2026-11-07 08:00",
              hour: "08:00",
              is_arrival_order: true,
              shift: "MORNING",
            },
          ]
        : ["07/11/2026"],
      attendance_create: { id: 99, start_date: "2026-11-07 08:00" },
    };
    return new Response(JSON.stringify({ data: { data: values[operation] ?? [] } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AmigoBooking initialConfig={config} onSaved={() => {}} />);
  expect(screen.getByRole("button", { name: "Consultar disponibilidade" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("CPF ou telefone"), { target: { value: "81999999999" } });
  fireEvent.click(screen.getByRole("button", { name: "Buscar paciente" }));
  fireEvent.click(await screen.findByRole("button", { name: "Selecionar Ana" }));
  await screen.findByRole("option", { name: "Consulta" });
  fireEvent.change(screen.getByLabelText("Tipo de atendimento"), { target: { value: "26" } });
  await screen.findByRole("option", { name: "Unimed" });
  fireEvent.change(screen.getByLabelText("Convênio"), { target: { value: "42" } });
  await screen.findByRole("option", { name: "Ouro" });
  fireEvent.change(screen.getByLabelText("Produto do convênio"), { target: { value: "13" } });
  await screen.findByRole("option", { name: "Gabi" });
  fireEvent.change(screen.getByLabelText("Médico"), { target: { value: "2437" } });
  fireEvent.click(screen.getByRole("button", { name: "Consultar disponibilidade" }));
  await screen.findByRole("option", { name: "07/11/2026" });
  fireEvent.change(screen.getByLabelText("Dia disponível"), { target: { value: "2026-11-07" } });
  fireEvent.click(await screen.findByRole("button", { name: /Manhã.*ordem de chegada/i }));
  expect(screen.getByText(/sem promessa de hora exata/i)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Agendar no Amigo" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => JSON.parse(String(init.body)).operation === "attendance_create",
      ),
    ).toBe(true),
  );
  const call = fetchMock.mock.calls.find(
    ([, init]) => JSON.parse(String(init.body)).operation === "attendance_create",
  )!;
  expect(JSON.parse(String(call[1].body)).input).toEqual({
    patient_id: 12,
    place_id: 774,
    event_id: 26,
    user_id: 2437,
    insurance_id: 42,
    insurance_product_id: 13,
    start_date: "2026-11-07 08:00",
    allow_same_day: false,
  });
  expect(new Headers(call[1].headers).get("Idempotency-Key")).toBeTruthy();
});
