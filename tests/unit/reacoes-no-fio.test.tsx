/**
 * A REAÇÃO NÃO É BALÃO (#2797/#2815).
 *
 * Medido na prova pela tela do #2815: a linha `type='reaction'` (corpo nulo,
 * `reply_to_message_id` = alvo) aparecia no fio como um SEGUNDO balão do
 * cliente, só com a citação do alvo e a hora — o 👍 aparecia 0 vezes. Quem lia
 * achava que o cliente citou a própria mensagem e não escreveu nada.
 *
 * O contrato: a reação sai do fio e vira marca no balão alvo, com rótulo
 * acessível; uma por autor por alvo (vale a mais nova); sem emoji ou sem alvo,
 * nada — nunca balão.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import { mergeThreadItems } from "@/components/inbox/ChatThread";
import { separarReacoes } from "@/lib/inbox/reacoes-no-fio";
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
    direction: "outbound",
    status: "sent",
    ack: null,
    error_code: null,
    error_message: null,
    body: "Segue a proposta",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: "2026-10-17T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-10-17T12:00:00.000Z",
    ...over,
  };
}

function reacao(over: Partial<Message> & { emoji: string; author?: string }): Message {
  const { emoji, author = "5511999999999@c.us", ...resto } = over;
  return msg({
    id: "r1",
    type: "reaction",
    direction: "inbound",
    status: "delivered",
    body: null,
    sent_via: "external_device",
    reply_to_message_id: "m1",
    sent_at: "2026-10-17T12:01:00.000Z",
    metadata: { reaction: { emoji, target_external_id: "wamid.alvo", author } },
    ...resto,
  });
}

describe("separarReacoes", () => {
  it("a reação sai do fio e vira marca no alvo", () => {
    const { falas, reacoesPorAlvo } = separarReacoes([msg(), reacao({ emoji: "👍" })]);
    expect(falas.map((m) => m.id)).toEqual(["m1"]);
    expect(reacoesPorAlvo.get("m1")).toEqual([{ emoji: "👍", direction: "inbound" }]);
    // E o fio montado a partir das falas não tem item para a reação.
    expect(mergeThreadItems(falas, []).map((i) => i.data.id)).toEqual(["m1"]);
  });

  it("uma por autor por alvo: a troca de 👍 por ❤️ mostra só o ❤️, em qualquer ordem de chegada", () => {
    const velha = reacao({ id: "r1", emoji: "👍", sent_at: "2026-10-17T12:01:00.000Z" });
    const nova = reacao({ id: "r2", emoji: "❤️", sent_at: "2026-10-17T12:02:00.000Z" });
    for (const lista of [[msg(), velha, nova], [nova, velha, msg()]]) {
      expect(separarReacoes(lista).reacoesPorAlvo.get("m1")).toEqual([{ emoji: "❤️", direction: "inbound" }]);
    }
  });

  it("autores diferentes somam no mesmo alvo", () => {
    const { reacoesPorAlvo } = separarReacoes([
      msg(),
      reacao({ id: "r1", emoji: "👍", author: "a@c.us" }),
      reacao({ id: "r2", emoji: "😂", author: "b@c.us", direction: "outbound" }),
    ]);
    expect(reacoesPorAlvo.get("m1")).toEqual([
      { emoji: "👍", direction: "inbound" },
      { emoji: "😂", direction: "outbound" },
    ]);
  });

  it("removida (a linha saiu do banco) = nenhuma marca", () => {
    expect(separarReacoes([msg()]).reacoesPorAlvo.size).toBe(0);
  });

  it("sem emoji ou sem alvo: não desenha nada, e nunca vira balão", () => {
    const { falas, reacoesPorAlvo } = separarReacoes([
      msg(),
      reacao({ id: "r1", emoji: "" }),
      reacao({ id: "r2", emoji: "👍", reply_to_message_id: null }),
    ]);
    expect(falas.map((m) => m.id)).toEqual(["m1"]);
    expect(reacoesPorAlvo.size).toBe(0);
  });
});

describe("MessageBubble com reação", () => {
  it("mostra o emoji junto do balão alvo, com rótulo acessível", () => {
    render(<MessageBubble message={msg()} reacoes={[{ emoji: "👍", direction: "inbound" }]} />);
    const marca = screen.getByRole("img", { name: "Cliente reagiu com 👍" });
    expect(marca.textContent).toBe("👍");
    // A marca mora DENTRO do balão alvo — não é um balão novo.
    expect(screen.getAllByTestId("message-bubble")).toHaveLength(1);
    expect(screen.getByTestId("message-bubble").contains(marca)).toBe(true);
  });

  it("sem reação, sem marca", () => {
    render(<MessageBubble message={msg()} />);
    expect(screen.queryByTestId("message-reactions")).toBeNull();
  });
});
