/**
 * A RESPOSTA DO "CHAMAR" NÃO PODE ESCONDER O PAINEL DE QUEM DISCOU.
 *
 * A ponte grava a ligação ~200 ms antes de `POST /voice/calls` responder, e o
 * Realtime entrega essa linha — com `owner_user_id` — primeiro. O hook trocava
 * a linha inteira pela resposta; enquanto a resposta não trazia o dono, o
 * painel decidia "não é minha" e sumia, com o botão de desligar junto.
 */
import { describe, expect, it } from "vitest";

import { mesclarRespostaDaChamada, type VoiceCallRow } from "@/hooks/voice/useVoiceCallSession";

const EU = "11111111-1111-4111-8111-111111111111";

function linha(over: Partial<VoiceCallRow> = {}): VoiceCallRow {
  return {
    id: "c1",
    contact_id: null,
    direction: "outbound",
    peer_phone: "553198966398",
    status: "ringing",
    end_reason: null,
    started_at: "2026-09-15T13:42:24.000Z",
    answered_at: null,
    owner_user_id: EU,
    created_by: null,
    ...over,
  };
}

describe("mesclarRespostaDaChamada", () => {
  it("resposta mais pobre não apaga o dono que o Realtime já trouxe", () => {
    const doRealtime = linha();
    const resposta = { id: "c1", status: "starting" } as unknown as VoiceCallRow;
    const m = mesclarRespostaDaChamada(doRealtime, resposta);
    expect(m.owner_user_id).toBe(EU);
    // O status do Realtime é mais novo que o da resposta.
    expect(m.status).toBe("ringing");
  });

  it("a resposta preenche o que o Realtime trouxe nulo", () => {
    const m = mesclarRespostaDaChamada(linha({ created_by: null, contact_id: null }), linha({ created_by: EU, contact_id: "k1" }));
    expect(m.created_by).toBe(EU);
    expect(m.contact_id).toBe("k1");
  });

  it("sem linha do Realtime, ou de OUTRA ligação, a resposta vale inteira", () => {
    const resposta = linha({ id: "c2" });
    expect(mesclarRespostaDaChamada(null, resposta)).toBe(resposta);
    expect(mesclarRespostaDaChamada(linha({ id: "c1" }), resposta)).toBe(resposta);
  });
});
