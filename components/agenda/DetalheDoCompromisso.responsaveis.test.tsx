import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "date-fns";

import { DetalheDoCompromisso } from "./DetalheDoCompromisso";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    patch: vi.fn(),
  },
}));
vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({
  usePessoasDaAgenda: vi.fn(),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  useLocaleDeData: () => ({} as Locale),
  useTagDeIdioma: () => "pt-BR",
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: vi.fn(),
}));

import { apiClient } from "@/lib/api/client";
import { usePessoasDaAgenda } from "@/hooks/agenda/usePessoasDaAgenda";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError } from "@/lib/api/types";

const get = vi.mocked(apiClient.get);
const patch = vi.mocked(apiClient.patch);
const pessoasHook = vi.mocked(usePessoasDaAgenda);

const PESSOAS = [
  { id: "p-1", nome: "Ana", trilha: 1 },
  { id: "p-2", nome: "Bruno", trilha: 2 },
  { id: "p-3", nome: "Carla", trilha: 3 },
];

const DETALHE = {
  id: "comp-1",
  title: "Consulta",
  description: null,
  notes: null,
  location_kind: null,
  location_details: null,
  service_space_id: null,
  calendar_resources: null,
  starts_at: "2026-10-07T13:00:00.000Z",
  ends_at: "2026-10-07T14:00:00.000Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  revision: 5,
  contact_id: "c-1",
  conversation_id: null,
  outcome_source_kind: null,
  outcome_recorded_at: null,
  recovery: null,
  evidence_messages: [],
  principal_user_id: "p-1",
  responsaveis: ["p-2"],
};

afterEach(cleanup);

function renderizar(detalhe = DETALHE, pessoas = PESSOAS, podeEditar = true) {
  get.mockResolvedValue({ data: detalhe });
  pessoasHook.mockReturnValue({ data: pessoas });
  const qc = new QueryClient();
  qc.setQueryData(["agenda", "pessoas"], PESSOAS);
  return render(
    <QueryClientProvider client={qc}>
      <DetalheDoCompromisso id="comp-1" onClose={vi.fn()} podeEditar={podeEditar} />
    </QueryClientProvider>,
  );
}

function textoQuemConduz() {
  return screen.getByTestId("compromisso-quem-conduz").textContent ?? "";
}

describe("DetalheDoCompromisso — responsáveis (#3067)", () => {
  it("confirmado (leitura): aparece o adicional gravado; botão salvar NÃO aparece sem mexer", async () => {
    renderizar(DETALHE, PESSOAS, false);
    await screen.findByTestId("compromisso-quem-conduz");
    expect(textoQuemConduz()).toContain("Conduz com:");
    expect(textoQuemConduz()).toContain("Bruno");
    expect(screen.queryByRole("button", { name: /Salvar quem conduz/ })).not.toBeInTheDocument();
  });

  it("adicionar uma pessoa e salvar → patch com responsible_user_ids = [gravado, novo] e a revision", async () => {
    patch.mockResolvedValue({});
    renderizar();
    await screen.findByTestId("compromisso-quem-conduz");
    fireEvent.change(screen.getByTestId("quem-conduz-adicionar"), {
      target: { value: "p-3" },
    });
    expect(screen.getByRole("button", { name: /Salvar quem conduz/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Salvar quem conduz/ }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/api/v1/agenda/agendamentos",
        expect.objectContaining({
          id: "comp-1",
          revision: 5,
          responsible_user_ids: ["p-2", "p-3"],
        }),
      ),
    );
  });

  it("retirar o único adicional e salvar → responsible_user_ids: []", async () => {
    patch.mockResolvedValue({});
    renderizar();
    await screen.findByTestId("compromisso-quem-conduz");
    fireEvent.click(screen.getByRole("button", { name: /Retirar Bruno/ }));
    fireEvent.click(screen.getByRole("button", { name: /Salvar quem conduz/ }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/api/v1/agenda/agendamentos",
        expect.objectContaining({
          id: "comp-1",
          revision: 5,
          responsible_user_ids: [],
        }),
      ),
    );
  });

  it("compromisso completed (leitura): sem seletor, mostra 'Conduz com: <nome>'", async () => {
    renderizar({ ...DETALHE, status: "completed" }, PESSOAS, false);
    await screen.findByTestId("compromisso-quem-conduz");
    expect(textoQuemConduz()).toContain("Conduz com:");
    expect(textoQuemConduz()).toContain("Bruno");
    expect(screen.queryByTestId("quem-conduz-adicionar")).not.toBeInTheDocument();
  });

  it("patch rejeitado com 409 responsavel_indisponível → showApiError recebe erro com o nome", async () => {
    patch.mockResolvedValue({});
    renderizar({ ...DETALHE, status: "confirmed" });
    await screen.findByTestId("compromisso-quem-conduz");
    const erro = new ApiError(409, "responsavel_indisponivel", { user_id: "p-2" }, "req-3");
    patch.mockRejectedValueOnce(erro);
    fireEvent.change(screen.getByTestId("quem-conduz-adicionar"), {
      target: { value: "p-3" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Salvar quem conduz/ }));
    await waitFor(() =>
      expect(showApiError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Bruno"),
        }),
      ),
    );
  });

  it("equipe_travada (sessão coletiva): mostra a nota, sem seletor nem botão salvar", async () => {
    renderizar({ ...DETALHE, equipe_travada: true }, PESSOAS, true);
    await screen.findByTestId("compromisso-quem-conduz");
    expect(screen.getByTestId("compromisso-equipe-travada")).toHaveTextContent(
      "A equipe desta sessão coletiva é definida por quem abre a sessão.",
    );
    expect(screen.queryByTestId("quem-conduz-adicionar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Salvar quem conduz/ })).not.toBeInTheDocument();
    // A nota aparece mesmo sem nomes gravados (sem responsaveis).
    renderizar({ ...DETALHE, equipe_travada: true, responsaveis: [] }, PESSOAS, true);
    expect(screen.getByTestId("compromisso-equipe-travada")).toBeInTheDocument();
  });
});
