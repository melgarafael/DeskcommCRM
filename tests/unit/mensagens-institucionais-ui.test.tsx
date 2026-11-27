/**
 * UI & i18n de mensagens institucionais (PR 02):
 *
 *  - `ApiTokensClient` expõe o escopo `messages:institutional` em PT-BR e ES;
 *  - `MessageBubble` distingue visualmente uma mensagem institucional gravada
 *    (`sent_via = "system"` + `metadata.dispatch_mode = "institutional"`) sem
 *    quebrar a exibição das mensagens comuns de integração.
 */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { ApiTokensClient } from "@/app/app/settings/api-tokens/_components/ApiTokensClient";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { Message } from "@/lib/types/messaging";

vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({ isLoading: false, data: { data: [] } }),
  useCreateApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeApiToken: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

function baseMsg(over: Partial<Message> = {}): Message {
  return {
    id: "m-1",
    organization_id: "org-1",
    conversation_id: "conv-1",
    channel_session_id: "sess-1",
    contact_id: "contact-1",
    external_id: "ext-1",
    type: "text",
    direction: "outbound",
    status: "sent",
    ack: 1,
    error_code: null,
    error_message: null,
    body: "Sua fatura vence em 2 dias.",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "system",
    sent_by_user_id: null,
    sent_at: "2026-11-25T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    metadata: {},
    created_at: "2026-11-25T12:00:00.000Z",
    updated_at: "2026-11-25T12:00:00.000Z",
    ...over,
  };
}

afterEach(cleanup);

describe("UI de mensagens institucionais (PR 02)", () => {
  it("ApiTokensClient exibe o escopo dedicado messages:institutional em PT-BR e ES", () => {
    const { unmount } = render(
      createElement(IdiomaProvider, { locale: "pt-BR", children: <ApiTokensClient /> }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
    expect(screen.getByRole("button", { name: /messages:institutional/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Enviar avisos institucionais sem alterar a fila, SLA ou silenciar a IA/),
    ).toBeInTheDocument();
    unmount();

    render(createElement(IdiomaProvider, { locale: "es", children: <ApiTokensClient /> }));
    fireEvent.click(screen.getByRole("button", { name: "Crear token" }));
    expect(screen.getByRole("button", { name: /messages:institutional/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Enviar avisos institucionales sin alterar la cola, el SLA ni silenciar la IA/),
    ).toBeInTheDocument();
  });

  it("MessageBubble distingue aviso institucional de mensagem operacional comum de integração", () => {
    const { unmount } = render(
      createElement(IdiomaProvider, {
        locale: "pt-BR",
        children: (
          <MessageBubble
            message={baseMsg({
              sent_via: "system",
              metadata: {
                dispatch_mode: "institutional",
                integration_actor_name: "ERP Financeiro",
              },
            })}
          />
        ),
      }),
    );

    const balaoInst = screen.getByTestId("message-bubble");
    expect(balaoInst).toHaveAttribute("data-dispatch-mode", "institutional");
    expect(screen.getByText("Aviso institucional · ERP Financeiro")).toBeInTheDocument();
    unmount();

    render(
      createElement(IdiomaProvider, {
        locale: "pt-BR",
        children: (
          <MessageBubble
            message={baseMsg({
              id: "m-2",
              sent_via: "system",
              metadata: { integration_actor_name: "ERP Financeiro" },
            })}
          />
        ),
      }),
    );

    const balaoComum = screen.getByTestId("message-bubble");
    expect(balaoComum).not.toHaveAttribute("data-dispatch-mode");
    expect(screen.getByText("Integração · ERP Financeiro")).toBeInTheDocument();
  });
});
