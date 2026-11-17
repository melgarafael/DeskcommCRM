/**
 * A MENSAGEM APAGADA NÃO GANHA "RESPONDER A ESTA MENSAGEM" (#4787).
 *
 * ─── O defeito, medido antes do conserto ───────────────────────────────────
 *
 * Encaminhar, Reagir e Baixar já eram bloqueados por `revoked_at`
 * (`components/inbox/MessageBubble.tsx`, as três condições ao lado de
 * `apagada`). "Responder a esta mensagem" dependia SÓ de `onResponder` existir:
 * numa mensagem apagada o item continuava no menu. A citação é o conteúdo da
 * mensagem num segundo lugar da tela — e, no envio, uma referência que sai para
 * a plataforma. O menu era o atalho de volta para o que o contato apagou.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * Abre o menu de verdade (Radix) e lê os itens que apareceram. O caso da
 * mensagem apagada usa `texto_retido: true` de propósito: é o estado em que o
 * botão "Ver texto retido" EXISTE — e é justamente ali que a ação de responder
 * não pode aparecer ao lado dele.
 *
 * O CONTROLE (mensagem viva, item presente e chamando `onResponder`) é o que
 * impede o gate de ficar verde pelo motivo errado: sumir com o item de TODO
 * balão passaria no primeiro caso e mataria a função.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/types/messaging";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "org1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    error_code: null,
    error_message: null,
    body: "texto que o contato apagou",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: "2026-09-08T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-09-08T12:00:00.000Z",
    ...over,
  };
}

describe("menu do balão — responder a uma mensagem apagada", () => {
  it("não oferece 'Responder a esta mensagem' para a apagada", () => {
    const onResponder = vi.fn();
    render(
      <MessageBubble
        message={msg({
          revoked_at: "2026-09-08T12:05:00.000Z",
          body: null,
          texto_retido: true,
        })}
        onResponder={onResponder}
        onEncaminhar={vi.fn()}
        onReagir={vi.fn()}
      />,
    );

    // O texto retido continua alcançável pela porta dele — o conserto é da
    // AÇÃO de responder, e não do recurso do #3277.
    expect(screen.getByRole("button", { name: "Ver texto retido" })).toBeInTheDocument();
    // E sem nenhuma outra ação cabível, o menu nem existe: um menu vazio seria
    // uma setinha que não abre nada.
    expect(screen.queryByRole("button", { name: "Opções da mensagem" })).toBeNull();
    expect(screen.queryByText("Responder a esta mensagem")).toBeNull();
    expect(onResponder).not.toHaveBeenCalled();
  });

  it("CONTROLE: a mensagem viva continua com a ação, e ela escolhe a mensagem", async () => {
    const user = userEvent.setup();
    const onResponder = vi.fn();
    render(<MessageBubble message={msg()} onResponder={onResponder} />);

    await user.click(screen.getByRole("button", { name: "Opções da mensagem" }));
    await user.click(await screen.findByRole("menuitem", { name: "Responder a esta mensagem" }));

    expect(onResponder).toHaveBeenCalledOnce();
    expect(onResponder.mock.calls[0]?.[0]).toMatchObject({ id: "m1" });
  });
});
