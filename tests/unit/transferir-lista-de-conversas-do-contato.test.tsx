/**
 * #4312 (defeito 3) — AS CONVERSAS DO MESMO CONTATO APARECEM NO DIÁLOGO DE TRANSFERIR.
 *
 * O contato fala por dois números; a conversa antiga fica em um deles e a nova
 * nasce no outro. Quem transfere a antiga não sabia que a nova existia — e a
 * resposta saía pela conversa errada, ou a conversa era transferida sem o fio.
 *
 * A lista fica no diálogo de Transferir, com o NÚMERO de cada conversa (é o que
 * distingue uma da outra) e um botão que abre a conversa certa. Nada de segundo
 * seletor na tela da conversa: um caminho só para a decisão.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { conversas, abrir } = vi.hoisted(() => ({ conversas: { valor: [] as unknown }, abrir: vi.fn() }));

const membros = [{ user_id: "ana-lima-0001", role: "agent", full_name: "Ana Lima" }];

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "eu-mesmo-0000" } }),
  usePaisDaOrgAtiva: () => null,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: membros, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useTransferConversation", () => ({
  useTransferConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useContinuarPorOutroNumero", () => ({
  useContinuarPorOutroNumero: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePreviaDaTransferencia", () => ({
  usePreviaDaTransferencia: () => ({ data: { numero: null, negocio: null }, isSuccess: true }),
}));
vi.mock("@/hooks/inbox/useConversasDoContato", () => ({
  useConversasDoContato: () => ({ data: conversas.valor, isSuccess: true }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { ReassignDialog } from "@/components/inbox/ReassignDialog";

function abrirDialogo() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ReassignDialog
        conversationId="conv-atual"
        open
        onOpenChange={() => {}}
        numero={{
          contactId: "contato-1",
          contactPhone: "+5511900000001",
          channelSessionId: "sessao-x",
          onAbrirConversa: abrir,
        }}
      />
    </QueryClientProvider>,
  );
}

const CONVERSAS = [
  {
    id: "conv-atual",
    channel_session_id: "sessao-x",
    status: "claimed",
    last_message_at: "2026-11-12T10:00:00Z",
    assigned_to_user_name: "Eu Mesmo",
    channel_sessions: { phone_number: "+5511900000001", display_name: "Numero X", provider: "waha" },
  },
  {
    id: "conv-outra",
    channel_session_id: "sessao-y",
    status: "open",
    last_message_at: "2026-11-12T09:00:00Z",
    assigned_to_user_name: null,
    channel_sessions: { phone_number: "+5511900000002", display_name: "Numero Y", provider: "waha" },
  },
];

beforeEach(() => {
  conversas.valor = CONVERSAS;
  abrir.mockClear();
});

describe("#4312 — a lista das conversas do contato no diálogo de Transferir", () => {
  it("⭐ lista a outra conversa COM O NÚMERO dela, e não a que está aberta", async () => {
    abrirDialogo();

    const bloco = await screen.findByTestId("conversas-do-contato");
    expect(within(bloco).getByText("+5511900000002")).toBeInTheDocument();
    // A conversa atual já está na tela atrás do diálogo: repetir aqui seria ruído.
    expect(within(bloco).queryByText("+5511900000001")).toBeNull();
  });

  it("'Abrir' leva para a conversa do outro número", async () => {
    abrirDialogo();

    const item = await screen.findByTestId("conversa-do-contato-conv-outra");
    const botao = within(item).getByRole("button", { name: /Abrir/ });
    fireEvent.click(botao);

    expect(abrir).toHaveBeenCalledWith("conv-outra");
  });

  it("CONTROLE: sem outra conversa, o diálogo diz isso em vez de mostrar lista vazia", async () => {
    conversas.valor = [CONVERSAS[0]];
    abrirDialogo();

    expect(await screen.findByTestId("conversas-do-contato-vazio")).toHaveTextContent(
      "Este contato não tem outra conversa.",
    );
  });
});
