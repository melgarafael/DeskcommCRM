import { describe, expect, it } from "vitest";
import { haQuantoTempo, montarColunas, type ConversaDoPainel } from "./painel-do-setor";

const agora = new Date("2026-10-23T21:00:00Z");
function conv(id: string, p: Partial<ConversaDoPainel>): ConversaDoPainel {
  return { id, status: "open", last_inbound_at: null, last_outbound_at: null, last_message_at: null, awaiting_since: null, ...p };
}

describe("painel do setor", () => {
  it("cliente que falou por último fica em Aguardando, o mais antigo em cima", () => {
    const { aguardando, emAtendimento } = montarColunas(
      [
        conv("novo", { last_inbound_at: "2026-10-23T20:50:00Z", last_outbound_at: "2026-10-23T20:00:00Z" }),
        conv("antigo", { last_inbound_at: "2026-10-23T19:00:00Z" }),
        conv("respondido", { last_inbound_at: "2026-10-23T19:30:00Z", last_outbound_at: "2026-10-23T19:31:00Z", last_message_at: "2026-10-23T19:31:00Z" }),
      ],
      agora,
    );
    expect(aguardando.map((c) => c.id)).toEqual(["antigo", "novo"]);
    expect(emAtendimento.map((c) => c.id)).toEqual(["respondido"]);
  });

  it("resposta da IA conta como atendimento", () => {
    const { aguardando, emAtendimento } = montarColunas(
      [conv("ia", { status: "ai_handling", last_inbound_at: "2026-10-23T20:00:00Z", last_outbound_at: "2026-10-23T20:00:05Z" })],
      agora,
    );
    expect(aguardando).toHaveLength(0);
    expect(emAtendimento.map((c) => c.id)).toEqual(["ia"]);
  });

  it("awaiting_since velho (antes da nossa resposta) não manda a conversa pro topo", () => {
    const { aguardando } = montarColunas(
      [
        conv("insistente", {
          awaiting_since: "2026-10-23T12:00:00Z",
          last_outbound_at: "2026-10-23T18:00:00Z",
          last_inbound_at: "2026-10-23T20:30:00Z",
        }),
        conv("esperando", { awaiting_since: "2026-10-23T19:00:00Z", last_inbound_at: "2026-10-23T19:10:00Z" }),
      ],
      agora,
    );
    expect(aguardando.map((c) => [c.id, c.esperandoDesde])).toEqual([
      ["esperando", "2026-10-23T19:00:00Z"],
      ["insistente", "2026-10-23T20:30:00Z"],
    ]);
  });

  it("encerradas hoje vão para Atendidos; as de outro dia e arquivadas ficam de fora", () => {
    const { atendidosHoje } = montarColunas(
      [
        conv("hoje", { status: "closed", service_closed_at: "2026-10-23T18:00:00Z" }),
        conv("ontem", { status: "closed", service_closed_at: "2026-10-21T18:00:00Z" }),
        conv("arquivada", { status: "archived", service_closed_at: "2026-10-23T18:00:00Z" }),
      ],
      agora,
    );
    expect(atendidosHoje.map((c) => c.id)).toEqual(["hoje"]);
  });

  it("mostra o tempo de espera de forma curta", () => {
    expect(haQuantoTempo("2026-10-23T20:35:00Z", agora)).toBe("25 min");
    expect(haQuantoTempo("2026-10-23T18:00:00Z", agora)).toBe("3 h");
    expect(haQuantoTempo("2026-10-20T21:00:00Z", agora)).toBe("3 d");
  });
});
