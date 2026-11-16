import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AmigoPatients } from "./_patients";
const contact = { id: "7241876f-d792-4e69-bbe9-7d75ce9be84c", name: "Responsável" };
const config = {
  configured: true,
  active: true,
  connection_id: "conn",
  token_last4: null,
  validated_at: null,
  default_place_id: 774,
  timezone: "America/Recife",
  reminders_enabled: false,
  last_sync_at: null,
  last_error: null,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("vincula apenas paciente e negócio escolhidos explicitamente ao responsável", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const data = url.includes("crm-summary")
      ? {
          leads: [
            {
              id: "c8dcff65-6324-48be-a6bd-9f4b561ff58b",
              title: "Tratamento",
              funil_nome: "Clínica",
            },
          ],
        }
      : url.includes("/links")
        ? { links: [], appointments: [], operations: [] }
        : {
            data:
              body.operation === "patient_search"
                ? [
                    { id: 12, name: "Ana" },
                    { id: 13, name: "Bia" },
                  ]
                : body.operation === "patient_get"
                  ? { id: 12, name: "Ana" }
                  : [],
          };
    return new Response(JSON.stringify({ data }));
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AmigoPatients config={config} contact={contact} canManage />);
  fireEvent.change(screen.getByLabelText("CPF ou telefone"), { target: { value: "81999999999" } });
  fireEvent.click(screen.getByRole("button", { name: "Buscar paciente" }));
  fireEvent.click(await screen.findByRole("button", { name: "Selecionar Ana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Vincular paciente ao contato" }));
  expect(
    fetchMock.mock.calls.filter(([url, init]) => url.endsWith("/links") && init?.method === "POST"),
  ).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Negócio para este paciente"), {
    target: { value: "c8dcff65-6324-48be-a6bd-9f4b561ff58b" },
  });
  fireEvent.click(screen.getByLabelText(/Confirmo que Ana/));
  fireEvent.click(screen.getByRole("button", { name: "Vincular paciente ao contato" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([url, init]) => url.endsWith("/links") && init?.method === "POST"),
    ).toBe(true),
  );
  const call = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith("/links") && init?.method === "POST",
  )!;
  expect(JSON.parse(String(call[1]?.body))).toEqual({
    patient_id: 12,
    contact_id: contact.id,
    lead_id: "c8dcff65-6324-48be-a6bd-9f4b561ff58b",
  });
});
it("editar nome não reenvia CPF telefone ou email mascarados", async () => {
  const masked = {
    id: 12,
    name: "Ana",
    cpf: "***.123.***-**",
    contact_cellphone: "(81) *****-1234",
    email: "a***@example.com",
  };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(
      JSON.stringify({
        data: {
          data:
            body.operation === "patient_search"
              ? [masked]
              : body.operation === "patient_get"
                ? masked
                : body.operation === "patient_update"
                  ? { ...masked, name: "Ana Maria" }
                  : [],
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AmigoPatients config={config} contact={null} canManage />);
  fireEvent.change(screen.getByLabelText("CPF ou telefone"), { target: { value: "81999999999" } });
  fireEvent.click(screen.getByRole("button", { name: "Buscar paciente" }));
  fireEvent.click(await screen.findByRole("button", { name: "Selecionar Ana" }));
  fireEvent.click(await screen.findByRole("button", { name: "Editar paciente" }));
  fireEvent.change(screen.getByLabelText("Nome do paciente"), { target: { value: "Ana Maria" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar paciente" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => JSON.parse(String(init?.body)).operation === "patient_update",
      ),
    ).toBe(true),
  );
  const call = fetchMock.mock.calls.find(
    ([, init]) => JSON.parse(String(init?.body)).operation === "patient_update",
  )!;
  expect(JSON.parse(String(call[1]?.body)).input).toEqual({ patientId: 12, name: "Ana Maria" });
});
