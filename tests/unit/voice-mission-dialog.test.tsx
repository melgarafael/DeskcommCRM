import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: mocks }));
import { VoiceMissionDialog } from "@/components/voice/VoiceMissionDialog";
const agent = "11111111-1111-4111-8111-111111111111";
const channel = "22222222-2222-4222-8222-222222222222";
const panel = {
  contact: { name: "Cliente QA", phone: "5511999999999" },
  missions: [] as object[],
  agents: [{ id: agent, name: "Atendimento", ready: true }],
  channels: [{ id: channel, name: "Comercial", status: "WORKING" }],
  contacts: [
    { id: "33333333-3333-4333-8333-333333333333", name: "Teste", phone_number: "5511888888888" },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ data: structuredClone(panel) });
  mocks.post.mockResolvedValue({ data: {} });
});
afterEach(cleanup);
async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VoiceMissionDialog conversationId="conversation" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Pedir ligação à IA" }));
  await screen.findByLabelText("Seu objetivo");
}
it("prepares unambiguous choices and requires explicit review and start", async () => {
  await open();
  expect(screen.getByText("Ajustes da ligação").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByLabelText("Agente")).toHaveValue(agent);
  expect(screen.getByLabelText("Número que fará a ligação")).toHaveValue(channel);
  fireEvent.change(screen.getByLabelText("Seu objetivo"), {
    target: { value: "Entender a dúvida sobre a proposta" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Revisar ligação" }));
  expect(screen.getByText("Ligar para Cliente QA")).toBeVisible();
  expect(mocks.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Ligar agora" }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        action: "start",
        agent_id: agent,
        channel_id: channel,
        test: false,
      }),
    ),
  );
});
it("keeps ambiguous choices pending and never starts when saving", async () => {
  mocks.get.mockResolvedValue({
    data: { ...panel, agents: [...panel.agents, { id: channel, name: "Outro", ready: true }] },
  });
  await open();
  expect(screen.getByLabelText("Agente")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "Salvar para depois" }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: "save", agent_id: null }),
    ),
  );
});
it("preserves existing incomplete test drafts rather than replacing choices", async () => {
  mocks.get.mockResolvedValue({
    data: {
      ...panel,
      missions: [
        {
          id: agent,
          status: "draft",
          objective: "Pedido anterior",
          agent_id: null,
          channel_id: null,
          test: true,
          test_contact_id: null,
        },
      ],
    },
  });
  await open();
  expect(screen.getByLabelText("Agente")).toHaveValue("");
  expect(screen.getByLabelText("Número que fará a ligação")).toHaveValue("");
  expect(screen.getByLabelText(/Fazer um teste primeiro/)).toBeChecked();
  expect(screen.getByLabelText("Seu objetivo")).toHaveValue("Pedido anterior");
});
it("keeps objective and choices after save failure", async () => {
  mocks.post.mockRejectedValue(new Error("Falha temporária"));
  await open();
  fireEvent.change(screen.getByLabelText("Seu objetivo"), {
    target: { value: "Resolver a dúvida" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Salvar para depois" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Falha temporária");
  expect(screen.getByLabelText("Seu objetivo")).toHaveValue("Resolver a dúvida");
  expect(screen.getByLabelText("Agente")).toHaveValue(agent);
});
