/**
 * O tique do canal OFICIAL (Cloud API) — #4316.
 *
 * `messages.status` do canal oficial é colapsado em `sent | failed` de
 * propósito (`lib/channels/meta/status-update.ts`): a entrega e a leitura
 * vivem nos carimbos `delivered_at` / `read_at`. Enquanto o tique lia só
 * `status`, a mensagem que a Meta confirmou entregue e lida ficava com um
 * risco só — "Enviada" para sempre.
 *
 * Os casos abaixo prendem a precedência (leitura > entrega > status) e os dois
 * atalhos que data nenhuma pode atropelar: `failed` ("Falhou") e a parada por
 * falta de conexão ("Não enviada — sem conexão").
 *
 * Sem provider de idioma o `t()` degrada para a chave (pt-BR), então o texto
 * esperado é o português — o espanhol é coberto por i18n-espanhol-cobre-a-tela.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

const ENTREGUE = "2026-09-21T12:00:05.000Z";
const LIDA = "2026-09-21T12:01:00.000Z";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: "wamid.HBg",
    type: "text",
    direction: "outbound",
    status: "sent",
    ack: null,
    error_code: null,
    error_message: null,
    body: "corpo da mensagem",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: "2026-09-21T11:59:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-09-21T11:59:00.000Z",
    ...over,
  };
}

describe("MessageBubble — tique do canal oficial (#4316)", () => {
  it("(d) lê o carimbo de leitura: mostra Lida com status colapsado em sent", () => {
    render(<MessageBubble message={msg({ delivered_at: ENTREGUE, read_at: LIDA })} />);
    expect(screen.queryByLabelText("Lida")).toBeTruthy();
  });

  it("(d) com só a hora de entrega mostra Entregue", () => {
    render(<MessageBubble message={msg({ delivered_at: ENTREGUE, read_at: null })} />);
    expect(screen.getByLabelText("Entregue")).toBeInTheDocument();
  });

  it("(d) sem carimbo nenhum mostra Enviada", () => {
    render(<MessageBubble message={msg({ delivered_at: null, read_at: null })} />);
    expect(screen.getByLabelText("Enviada")).toBeInTheDocument();
  });

  it("(e) failed continua Falhou, com ou sem datas gravadas", () => {
    render(
      <MessageBubble
        message={msg({ status: "failed", delivered_at: ENTREGUE, read_at: LIDA })}
      />,
    );
    expect(screen.getByText("Falhou")).toBeInTheDocument();
    expect(screen.queryByLabelText("Lida")).not.toBeInTheDocument();
  });

  it("(f) parada sem conexão não é atropelada pelos carimbos", () => {
    render(
      <MessageBubble
        message={msg({
          status: "queued",
          delivered_at: ENTREGUE,
          read_at: LIDA,
          metadata: { queued_reason: "canal_pausado" },
        })}
      />,
    );
    expect(screen.getByText("Não enviada — sem conexão")).toBeInTheDocument();
    expect(screen.queryByLabelText("Lida")).not.toBeInTheDocument();
  });
});
