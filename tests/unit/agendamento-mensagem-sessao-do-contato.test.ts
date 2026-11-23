import { describe, expect, it } from "vitest";
import { escolherConversaConectada, type ConversaDoContato } from "@/lib/agendamento-mensagem/sessao-do-contato";

function conversa(parcial: Partial<ConversaDoContato> & { id: string }): ConversaDoContato {
  return {
    channel_session_id: "sessao-padrao",
    ultimo_contato_em: "2026-11-20T10:00:00.000Z",
    status_da_sessao: "WORKING",
    ...parcial,
  };
}

describe("escolha da conversa de envio (#4431)", () => {
  it("usa a conversa conectada mais recente do contato", () => {
    const escolhida = escolherConversaConectada([
      conversa({ id: "antiga", channel_session_id: "s1", ultimo_contato_em: "2026-11-01T10:00:00.000Z" }),
      conversa({ id: "recente", channel_session_id: "s2", ultimo_contato_em: "2026-11-22T10:00:00.000Z" }),
    ]);
    expect(escolhida).toEqual({ conversation_id: "recente", channel_session_id: "s2" });
  });

  it("ignora a conversa mais recente se a sessão dela não está conectada", () => {
    const escolhida = escolherConversaConectada([
      conversa({ id: "parada-recente", channel_session_id: "s-parada", status_da_sessao: "STOPPED", ultimo_contato_em: "2026-11-23T10:00:00.000Z" }),
      conversa({ id: "conectada-antiga", channel_session_id: "s-nova", ultimo_contato_em: "2026-11-02T10:00:00.000Z" }),
    ]);
    expect(escolhida).toEqual({ conversation_id: "conectada-antiga", channel_session_id: "s-nova" });
  });

  it("sem nenhuma sessão conectada, não escolhe nada (a série espera)", () => {
    expect(
      escolherConversaConectada([conversa({ id: "a", status_da_sessao: "STOPPED" }), conversa({ id: "b", status_da_sessao: null })]),
    ).toBeNull();
  });

  it("sem conversa nenhuma, não escolhe nada", () => {
    expect(escolherConversaConectada([])).toBeNull();
  });

  it("sem data de contato, a ordem recebida decide (determinístico)", () => {
    const escolhida = escolherConversaConectada([
      conversa({ id: "primeira", ultimo_contato_em: null, channel_session_id: "s1" }),
      conversa({ id: "segunda", ultimo_contato_em: null, channel_session_id: "s2" }),
    ]);
    expect(escolhida?.conversation_id).toBe("primeira");
  });
});
