import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
const get = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const translate = vi.hoisted(() => (s: string) => s);
vi.mock("@/lib/api/client", () => ({ apiClient: { get, patch } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => translate }));
import { MemberAccessDialog } from "./MemberAccessDialog";
const close = vi.fn();
function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemberAccessDialog
        member={{ id: "a1600000-0000-4000-8000-000000000001", name: "Atendente sintético" }}
        onClose={close}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({
    data: {
      scope: null,
      pipelines: [
        { id: "p-a", name: "Rede" },
        { id: "p-b", name: "Vendas" },
      ],
      channels: [
        { id: "c-a", display_name: "Cida sintética", phone_number: null },
        { id: "c-b", display_name: "Comercial sintético", phone_number: null },
      ],
    },
  });
  patch.mockResolvedValue({ data: { saved: true } });
});
it("sem perfil exige seleção explícita e salva somente funil/número escolhidos", async () => {
  mount();
  fireEvent.click(await screen.findByLabelText("Rede"));
  fireEvent.click(screen.getByLabelText("Cida sintética"));
  fireEvent.click(screen.getByRole("button", { name: "Salvar acessos" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(
      "/api/v1/team/access-scopes",
      expect.objectContaining({
        pipeline_ids: ["p-a"],
        channel_ids: ["c-a"],
        restrict_contacts: true,
        reset: false,
      }),
    ),
  );
  expect(close).toHaveBeenCalled();
});
it("Todos usa null, distinto de seleção vazia", async () => {
  mount();
  const group = await screen.findByRole("group", { name: "Números permitidos" });
  fireEvent.click(within(group).getByLabelText("Todos"));
  fireEvent.click(screen.getByRole("button", { name: "Salvar acessos" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pipeline_ids: [], channel_ids: null }),
    ),
  );
});
it("falha de leitura mantém salvar bloqueado, sem escrita", async () => {
  get.mockRejectedValue(new Error("local failure"));
  mount();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Salvar acessos" })).toBeDisabled();
  expect(patch).not.toHaveBeenCalled();
});
it("erro ao salvar mantém diálogo e escolhas para corrigir", async () => {
  patch.mockRejectedValue(new Error("local failure"));
  mount();
  fireEvent.click(await screen.findByLabelText("Rede"));
  fireEvent.click(screen.getByRole("button", { name: "Salvar acessos" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Rede")).toBeChecked();
  expect(close).not.toHaveBeenCalled();
});
