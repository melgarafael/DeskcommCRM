/**
 * Trocar a chave zera o veredito, e o teste da chave nova roda depois da
 * resposta. A lista não se relê sozinha para uma chave antiga trocada (o
 * "validando" sai de `created_at`), então quem relê é o diálogo. Com uma
 * releitura só, aos 3 s, um teste mais lento deixava o card — e o "Usada em"
 * do Jev — parado até recarregar a página.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RotateCredentialDialog } from "./RotateCredentialDialog";
import { credentialStatus, useCredentialsList, type CredentialRow } from "@/hooks/ai/useCredentials";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
const avisos = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: avisos }));

const antiga: CredentialRow = {
  id: "c1",
  organization_id: "o1",
  provider: "typesafe",
  label: "Jev (TypeSafe AI)",
  api_key_last4: "cdef",
  validated_at: null,
  validation_error: null,
  models_available: null,
  is_active: true,
  created_by: null,
  created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
  updated_at: new Date(Date.now() - 60 * 60_000).toISOString(),
};

function Status() {
  const { data } = useCredentialsList({ initialData: [antiga] });
  const linha = data?.[0];
  return <p data-testid="status">{linha ? credentialStatus(linha) : ""}</p>;
}

describe("RotateCredentialDialog — depois de trocar a chave", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("relê a lista até o teste da chave responder, mesmo passando de 3 s", async () => {
    let linha = antiga;
    api.get.mockImplementation(async () => ({ data: [linha] }));
    api.patch.mockResolvedValue({ data: { id: "c1" } });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <Status />
        <RotateCredentialDialog open onOpenChange={() => {}} credential={antiga} />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText("Nova chave (opcional)"), {
      target: { value: "apikey_0123456789abcdef" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    });
    expect(api.patch).toHaveBeenCalledTimes(1);

    // O teste da chave nova termina aos 4 s — depois da releitura dos 3 s.
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(screen.getByTestId("status")).toHaveTextContent(/^unvalidated$/);
    linha = { ...antiga, validated_at: new Date().toISOString(), models_available: ["jev-latest"] };

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByTestId("status")).toHaveTextContent(/^validated$/);
    expect(avisos.success).toHaveBeenCalledWith("Validada — 1 modelos disponíveis.");

    // Com o veredito na mão, para de reler.
    const leituras = api.get.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.get.mock.calls.length).toBe(leituras);
  });
});
