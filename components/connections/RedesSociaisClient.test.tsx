import { beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RedesSociaisClient } from "./RedesSociaisClient";
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: h.get, post: h.post, delete: h.remove } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("./ChannelAiAccess", () => ({ ChannelAiAccess: () => <div>IA pausada</div> }));
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RedesSociaisClient />
    </QueryClientProvider>,
  );
}
it("shows connected networks and offers inbox only where implemented", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [
        { id: "instagram", label: "Instagram" },
        { id: "linkedin", label: "LinkedIn" },
      ],
      accounts: [
        {
          id: "a",
          platform: "instagram",
          username: "brand",
          active: true,
          inbox_supported: true,
          channel: null,
        },
        {
          id: "b",
          platform: "linkedin",
          username: "person",
          active: true,
          inbox_supported: false,
          channel: null,
        },
      ],
    },
  });
  h.post.mockResolvedValue({ data: { channel_id: "c" } });
  mount();
  await screen.findByText("brand");
  expect(screen.getAllByRole("button", { name: "Receber no atendimento" })).toHaveLength(1);
  expect(h.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Receber no atendimento" }));
  await screen.findByText("person");
  expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", {
    action: "inbox",
    account_id: "a",
  });
});
it("shows errors rather than a false empty or connected state", async () => {
  h.get.mockRejectedValue(new Error("Credencial recusada"));
  mount();
  expect((await screen.findByRole("alert")).textContent).toContain("Credencial recusada");
});
it("asks before removing an account from support and keeps it linked", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [
        {
          id: "a",
          platform: "instagram",
          username: "brand",
          active: true,
          inbox_supported: true,
          channel: { id: "c", status: "WORKING", metadata: {} },
        },
      ],
    },
  });
  h.post.mockResolvedValue({ data: { channel_id: "c", account_removed: false } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Remover do atendimento" }));
  expect(h.post).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Remover" }));
  await vi.waitFor(() =>
    expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", {
      action: "disconnect",
      account_id: "a",
      remove_account: false,
    }),
  );
});
it("shows orphaned channels and removes them through the disconnect action, which deletes the provider webhook", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [],
      orphaned_channels: [
        { channel_id: "ch-orfa", account_id: "velha", display_name: "Instagram velha", status: "FAILED" },
      ],
    },
  });
  h.post.mockResolvedValue({ data: { channel_id: "ch-orfa", account_removed: false } });
  mount();
  await screen.findByText("Canais sem conta no perfil");
  fireEvent.click(screen.getByRole("button", { name: "Excluir" }));
  fireEvent.click(await screen.findByRole("button", { name: "Excluir canal" }));
  await vi.waitFor(() =>
    expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", {
      action: "disconnect",
      account_id: "velha",
      remove_account: false,
    }),
  );
  // channel-sessions/[id] não apaga a assinatura no provedor: ela ficaria viva.
  expect(h.remove).not.toHaveBeenCalled();
});
it("asks before unlinking the profile and posts unlink on confirm", async () => {
  h.get.mockResolvedValue({
    data: {
      configured: true,
      label: "Partner",
      networks: [{ id: "instagram", label: "Instagram" }],
      accounts: [],
      orphaned_channels: [],
    },
  });
  h.post.mockResolvedValue({ data: { desvinculado: true } });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Desvincular perfil" }));
  expect(h.post).not.toHaveBeenCalled();
  await screen.findByText("Desvincular o perfil?");
  fireEvent.click(screen.getByRole("button", { name: /^Desvincular$/ }));
  await vi.waitFor(() =>
    expect(h.post).toHaveBeenCalledWith("/api/v1/channels/social", { action: "unlink" }),
  );
});
