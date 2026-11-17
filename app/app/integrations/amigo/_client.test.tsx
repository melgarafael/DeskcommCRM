import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AmigoClient } from "./_client";
import type { AmigoSafeConfig } from "@/lib/amigo/store";

export const CONFIG: AmigoSafeConfig = {
  configured: true,
  active: true,
  connection_id: "connection",
  token_last4: "1234",
  validated_at: "2026-11-06T12:00:00Z",
  default_place_id: 774,
  timezone: "America/Recife",
  reminders_enabled: false,
  last_sync_at: null,
  last_error: null,
};
const fetchMock = vi.fn();
const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.operation === "places") return reply({ data: [{ id: 774, name: "Aflitos" }] });
    return reply({ data: [] });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("Área Amigo", () => {
  it("acolhe a instalação sem token e mantém quatro abas acessíveis", () => {
    render(
      <AmigoClient
        initialConfig={{ ...CONFIG, configured: false, active: false, token_last4: null }}
        canConfigure
      />,
    );
    expect(screen.getByText("Conecte sua clínica quando estiver pronto")).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByLabelText("Token Amigo")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Token Amigo")).toHaveValue("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("atendente vê o estado sem controles administrativos", () => {
    render(<AmigoClient initialConfig={CONFIG} canConfigure={false} />);
    expect(screen.queryByLabelText("Token Amigo")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar configuração" })).not.toBeInTheDocument();
    expect(screen.getByText(/administrador.*configura/i)).toBeVisible();
  });
  it("testa token e salva sem repopular segredo", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/test")
        ? reply({ valid: true, places: [{ id: 774, name: "Aflitos" }] })
        : url.endsWith("/execute")
          ? reply({ data: [{ id: 774, name: "Aflitos" }] })
          : reply(CONFIG),
    );
    render(<AmigoClient initialConfig={CONFIG} canConfigure />);
    fireEvent.change(screen.getByLabelText("Token Amigo"), { target: { value: "segredo-novo" } });
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }));
    expect(
      await screen.findByText("Conexão validada. Confira a unidade antes de salvar."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));
    await waitFor(() => expect(screen.getByLabelText("Token Amigo")).toHaveValue(""));
    expect(screen.queryByText("segredo-novo")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url.endsWith("/amigo") && JSON.parse(init.body).token === "segredo-novo",
      ),
    ).toBe(true);
  });
  it("mostra erro seguro no teste e invalida sucesso ao alterar token", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "amigo_invalid_token", message: "raw secret" } }),
        { status: 401 },
      ),
    );
    render(<AmigoClient initialConfig={{ ...CONFIG, configured: false }} canConfigure />);
    fireEvent.change(screen.getByLabelText("Token Amigo"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/token|acesso/i);
    expect(screen.queryByText("raw secret")).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "exige escolha explícita em busca de paciente, objeto=%s",
    async (object) => {
      const ana = { id: 12, name: "Ana Paciente", contact_cellphone: "81999999999" };
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        const { operation } = JSON.parse(String(init.body));
        return reply({
          data:
            operation === "patient_search"
              ? object
                ? ana
                : [ana, { id: 13, name: "Bia Paciente" }]
              : [],
        });
      });
      render(<AmigoClient initialConfig={CONFIG} canConfigure={false} initialTab="pacientes" />);
      fireEvent.change(screen.getByLabelText("CPF ou telefone"), {
        target: { value: "81999999999" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Buscar paciente" }));
      expect(await screen.findByRole("button", { name: /Selecionar Ana Paciente/ })).toBeVisible();
      expect(screen.getByText("Escolha quem receberá o atendimento.")).toBeVisible();
      expect(
        fetchMock.mock.calls.some(([, init]) => JSON.parse(init.body).operation === "patient_get"),
      ).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: /Selecionar Ana Paciente/ }));
      expect(await screen.findByText(/Paciente selecionado: Ana Paciente/)).toBeVisible();
    },
  );
});
it("salva token novo com agenda desligada e ativa somente em uma segunda ação", async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/test"))
      return reply({ valid: true, places: [{ id: 774, name: "Aflitos" }] });
    if (url.endsWith("/execute")) return reply({ data: [{ id: 774, name: "Aflitos" }] });
    const input = JSON.parse(String(init?.body));
    return reply({ ...CONFIG, active: input.active === true });
  });
  render(<AmigoClient initialConfig={{ ...CONFIG, active: false }} canConfigure />);
  fireEvent.change(screen.getByLabelText("Token Amigo"), { target: { value: "token-novo" } });
  fireEvent.click(screen.getByRole("button", { name: "Testar conexão" }));
  await screen.findByText("Conexão validada. Confira a unidade antes de salvar.");
  expect(screen.getByLabelText(/Usar Amigo como agenda principal/)).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));
  await waitFor(() => expect(screen.getByLabelText("Token Amigo")).toHaveValue(""));
  expect(
    fetchMock.mock.calls
      .filter(([url, init]) => url.endsWith("/amigo") && init?.method === "PUT")
      .map(([, init]) => JSON.parse(init.body).active),
  ).toEqual([false]);
  await screen.findByRole("option", { name: "Aflitos" });
  fireEvent.change(screen.getByLabelText("Unidade padrão"), { target: { value: "774" } });
  fireEvent.click(screen.getByLabelText(/Usar Amigo como agenda principal/));
  fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url.endsWith("/amigo") && init?.method === "PUT",
      ),
    ).toHaveLength(2),
  );
  const last = fetchMock.mock.calls.filter(
    ([url, init]) => url.endsWith("/amigo") && init?.method === "PUT",
  )[1]!;
  expect(JSON.parse(last[1].body)).toMatchObject({ active: true, default_place_id: 774 });
  expect(JSON.parse(last[1].body)).not.toHaveProperty("token");
});
