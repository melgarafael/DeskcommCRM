/**
 * O telefone da conversa cai — e o atendente continua pelo outro número.
 *
 * Antes não havia por onde: a conversa é presa ao número (índice único por
 * contato e sessão) e o Transferir só trocava de atendente. Os casos prendem a
 * saída nova: a faixa aparece só com o número caído E outro conectado, abre o
 * Transferir já na aba Número, número fora do ar não é escolhível, e continuar
 * abre a conversa do outro número e a seleciona.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mutate = vi.fn();
const lista: { sessoes: unknown[] } = { sessoes: [] };

vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: lista.sessoes, isLoading: false, isError: false }),
  channelLabel: (c: { display_name: string | null; phone_number: string | null }) =>
    c.display_name || c.phone_number || "?",
}));
vi.mock("@/hooks/inbox/useContinuarPorOutroNumero", () => ({
  useContinuarPorOutroNumero: () => ({ mutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useTransferConversation", () => ({
  useTransferConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ user: { id: "eu" } }) }));

// O Select do Radix não abre em jsdom (pointer capture). O teste mira a regra —
// que opção existe, qual está desabilitada, o que sai ao escolher —, não o
// popover; por isso ele vira uma lista de botões com o mesmo contrato.
vi.mock("@/components/ui/select", () => {
  const Ctx = React.createContext<(v: string) => void>(() => {});
  return {
    Select: ({ onValueChange, children }: { onValueChange: (v: string) => void; children: React.ReactNode }) => (
      <Ctx.Provider value={onValueChange}>{children}</Ctx.Provider>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, disabled, children }: { value: string; disabled?: boolean; children: React.ReactNode }) => {
      const escolher = React.useContext(Ctx);
      return (
        <button type="button" role="option" aria-selected={false} disabled={disabled} onClick={() => escolher(value)}>
          {children}
        </button>
      );
    },
  };
});

import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

import { NumeroForaDoAr } from "./NumeroForaDoAr";

const sessao = (id: string, status: string, phone: string | null = `5571${id}`) => ({
  id,
  provider: DEFAULT_CHANNEL_PROVIDER,
  status,
  phone_number: phone,
  display_name: `Número ${id}`,
});

function montar(contactPhone: string | null = "5571988887777") {
  const onAbrirConversa = vi.fn();
  render(
    <NumeroForaDoAr
      conversationId="conv-a"
      channelSessionId="a"
      contactId="contato-1"
      contactPhone={contactPhone}
      onAbrirConversa={onAbrirConversa}
    />,
  );
  return onAbrirConversa;
}

describe("NumeroForaDoAr — responder por outro número", () => {
  beforeEach(() => {
    mutate.mockReset();
    lista.sessoes = [sessao("a", "FAILED"), sessao("b", "WORKING"), sessao("c", "STOPPED")];
  });

  it("com o número caído, abre o Transferir na aba Número e continua pelo escolhido", async () => {
    const onAbrirConversa = montar();
    await userEvent.click(screen.getByRole("button", { name: "Responder por outro número" }));

    expect(screen.getByRole("option", { name: /Número c/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("option", { name: /Número b/ }));
    await userEvent.click(screen.getByTestId("btn-continuar-pelo-numero"));

    expect(mutate).toHaveBeenCalledWith(
      { contact_id: "contato-1", channel_session_id: "b" },
      expect.anything(),
    );
    mutate.mock.calls[0]![1].onSuccess("conv-b");
    expect(onAbrirConversa).toHaveBeenCalledWith("conv-b");
  });

  it("fica quieta com o número da conversa conectado", () => {
    lista.sessoes = [sessao("a", "WORKING"), sessao("b", "WORKING")];
    montar();
    expect(screen.queryByTestId("numero-fora-do-ar")).toBeNull();
  });

  it("contato sem telefone: explica e não deixa continuar", async () => {
    montar(null);
    await userEvent.click(screen.getByRole("button", { name: "Responder por outro número" }));
    await userEvent.click(screen.getByRole("option", { name: /Número b/ }));
    expect(screen.getByTestId("btn-continuar-pelo-numero")).toBeDisabled();
    expect(screen.getByText(/não tem telefone salvo/)).toBeInTheDocument();
  });
});
