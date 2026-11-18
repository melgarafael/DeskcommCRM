import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AmigoAgenda } from "./_agenda";
const config = {
  configured: true,
  active: true,
  connection_id: "conn",
  token_last4: "1234",
  validated_at: null,
  default_place_id: 774,
  timezone: "America/Recife",
  reminders_enabled: false,
  last_sync_at: null,
  last_error: null,
};
const fetchMock = vi.fn();
function ok(data: unknown) {
  return new Response(JSON.stringify({ data: { data } }));
}
const appointment = {
  id: 75271,
  patient_id: 12,
  event_id: 26,
  start_date: "2026-11-06 08:00",
  status: "scheduled",
  patient: { id: 12, name: "Ana" },
  user: { id: 2437, name: "Gabi" },
  place: { id: 774, name: "Aflitos" },
  agenda_event: { id: 26, name: "Consulta" },
};
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { operation } = JSON.parse(String(init.body));
    if (operation === "attendances") return ok([appointment]);
    if (operation === "places") return ok([{ id: 774, name: "Aflitos" }]);
    return ok([]);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});
it("lista todos os estados com período e não oferece gravações não suportadas", async () => {
  render(<AmigoAgenda initialConfig={config} />);
  expect(await screen.findByText("Ana")).toBeVisible();
  const request = fetchMock.mock.calls.find(
    ([, init]) => JSON.parse(init.body).operation === "attendances",
  );
  expect(JSON.parse(request![1].body).input).toEqual(
    expect.objectContaining({
      status: "ALL",
      start_date: expect.any(String),
      end_date: expect.any(String),
    }),
  );
  expect(screen.getByRole("button", { name: "Confirmar" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Registrar chegada" })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Concluir|Marcar falta/ })).toBeNull();
});
it("mantém a chave após falha de rede e só confirma após resposta remota", async () => {
  let attempts = 0;
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { operation } = JSON.parse(String(init.body));
    if (operation === "attendances") return ok([appointment]);
    if (operation === "attendance_status") {
      if (++attempts === 1) throw new TypeError("network");
      return ok(true);
    }
    return ok([]);
  });
  render(<AmigoAgenda initialConfig={config} />);
  fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/não confirmado|incerto/i);
  expect(screen.queryByText("Alteração confirmada no Amigo.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Conferir resultado" }));
  await waitFor(() => expect(attempts).toBe(2));
  const calls = fetchMock.mock.calls.filter(
    ([, init]) => JSON.parse(init.body).operation === "attendance_status",
  );
  expect(new Headers(calls[0]![1].headers).get("Idempotency-Key")).toBeTruthy();
  expect(new Headers(calls[0]![1].headers).get("Idempotency-Key")).toBe(
    new Headers(calls[1]![1].headers).get("Idempotency-Key"),
  );
  expect(JSON.parse(calls[0]![1].body).operation_key).toBe(
    JSON.parse(calls[1]![1].body).operation_key,
  );
});
it("resultado incerto nunca aparece como sucesso", async () => {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
    JSON.parse(String(init.body)).operation === "attendance_status"
      ? new Response(
          JSON.stringify({
            data: { data: null, uncertain: true, operation_id: "receipt-1", state: "uncertain" },
          }),
        )
      : ok([appointment]),
  );
  render(<AmigoAgenda initialConfig={config} />);
  fireEvent.click(await screen.findByRole("button", { name: "Confirmar" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/incerto/i);
  expect(screen.getAllByText(/receipt-1/)[0]).toBeVisible();
  expect(screen.queryByText("Alteração confirmada no Amigo.")).not.toBeInTheDocument();
});
it("atendente consulta apenas o paciente escolhido e envia o contexto do contato", async () => {
  const contactId = "7241876f-d792-4e69-bbe9-7d75ce9be84c";
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { operation } = JSON.parse(String(init.body));
    return ok(
      operation === "patient_search"
        ? [{ id: 12, name: "Ana" }]
        : operation === "patient_attendances"
          ? [appointment]
          : [],
    );
  });
  render(<AmigoAgenda initialConfig={config} canManage={false} contactId={contactId} />);
  fireEvent.change(screen.getByLabelText("CPF ou telefone"), { target: { value: "81999999999" } });
  fireEvent.click(screen.getByRole("button", { name: "Buscar paciente" }));
  fireEvent.click(await screen.findByRole("button", { name: "Selecionar Ana" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => JSON.parse(init.body).operation === "patient_attendances",
      ),
    ).toBe(true),
  );
  expect(
    fetchMock.mock.calls.some(([, init]) => JSON.parse(init.body).operation === "attendances"),
  ).toBe(false);
  const call = fetchMock.mock.calls.find(
    ([, init]) => JSON.parse(init.body).operation === "patient_attendances",
  )!;
  expect(JSON.parse(call[1].body)).toMatchObject({
    contact_id: contactId,
    input: { patient_id: 12 },
  });
});
it("filtra estado do paciente pelos indicadores quando status textual não existe", async () => {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { operation } = JSON.parse(String(init.body));
    return ok(
      operation === "patient_search"
        ? [{ id: 12, name: "Ana" }]
        : operation === "patient_attendances"
          ? [{ ...appointment, status: undefined, confirmed_at: "2026-11-06 07:00" }]
          : [],
    );
  });
  render(
    <AmigoAgenda
      initialConfig={config}
      canManage={false}
      contactId="7241876f-d792-4e69-bbe9-7d75ce9be84c"
    />,
  );
  fireEvent.change(screen.getByLabelText("CPF ou telefone"), { target: { value: "81999999999" } });
  fireEvent.click(screen.getByRole("button", { name: "Buscar paciente" }));
  fireEvent.click(await screen.findByRole("button", { name: "Selecionar Ana" }));
  await screen.findByRole("article");
  fireEvent.change(screen.getByLabelText("Estado da consulta"), { target: { value: "CONFIRMED" } });
  expect(screen.getByRole("article")).toHaveTextContent("Confirmada");
  expect(screen.queryByText("Nenhuma consulta para estes filtros.")).not.toBeInTheDocument();
});

it("exibe turno e intervalo quando ordem de chegada vem na configuração do médico", async () => {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { operation } = JSON.parse(String(init.body));
    return ok(
      operation === "attendances"
        ? [
            {
              ...appointment,
              user: { ...appointment.user, config_arrival_order: true },
              shift: "AFTERNOON",
              arrival_start_time: "13:00",
              arrival_end_time: "17:00",
            },
          ]
        : [],
    );
  });
  render(<AmigoAgenda initialConfig={config} />);
  expect(await screen.findByText(/ordem de chegada, sem promessa de hora exata/)).toHaveTextContent(
    "13:00",
  );
});
