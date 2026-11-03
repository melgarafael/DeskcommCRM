import { describe, expect, it } from "vitest";
import { julgarAtualizacao } from "@/lib/inbox/atualizacao-da-lista";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/**
 * O JULGAMENTO NO CLIENTE NÃO PODE TIRAR DA LISTA O QUE O SERVIDOR MANTÉM (#2366).
 *
 * `julgarAtualizacao` só pode dizer "sai" quando a rota (`_handler.ts`) também
 * tiraria a conversa. Onde a régua do cliente difere da do servidor, a linha some
 * da tela e volta no próximo refetch — o mesmo estado falso que o conserto quis
 * evitar, na direção contrária.
 */
const base = {
  id: "c1",
  status: "open",
  assigned_to_user_id: "u-outra",
  is_group: false,
} as unknown as ConversationWithContact;

describe("julgarAtualizacao segue a régua da rota", () => {
  it("exclude_finished esconde só closed/archived (CONVERSATION_TERMINAL_STATUSES), não resolved", () => {
    expect(julgarAtualizacao(base, { id: "c1", status: "resolved" }, { exclude_finished: true })).not.toBe("sai");
    expect(julgarAtualizacao(base, { id: "c1", status: "closed" }, { exclude_finished: true })).toBe("sai");
  });

  it("Minhas: dono trocado não é decidível no cliente — a conversa pode estar lá por participação (#2848)", () => {
    expect(
      julgarAtualizacao(base, { id: "c1", assigned_to_user_id: "u-terceira" }, { assigned_to: "me" }),
    ).toBe("indecidivel");
    expect(julgarAtualizacao(base, { id: "c1", status: "pending" }, { assigned_to: "me" })).toBe("fica");
  });
});
