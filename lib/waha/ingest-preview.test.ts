import { describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env);
// o mock corta a cadeia sem tocar no que está sob teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { previewFromMessage, type WahaPayload } from "@/lib/waha/ingest";

/**
 * A prévia da lista da Inbox não pode ser o literal `[contact]` (issue #2742).
 *
 * Medido na prova do #2712 (vps-teste, banco fresco): conversa cuja última
 * mensagem é um vCard mostrava `[contact]` na lista. A causa é que o payload
 * NOWEB vem SEM `body` — o cartão mora em `_data.message.contactMessage.vcard` —
 * e `previewFromMessage` só olhava `p.body` antes de cair em `[${tipo}]`.
 *
 * O que tem que estar na tela de quem atende é o nome lido no `FN:` do cartão
 * (o mesmo parser do #2712), em português: `Contato: <nome>`.
 *
 * ⚠️ Este teste entra pela FUNÇÃO EXPORTADA (`previewFromMessage`) e não pelo
 * `dispatchWahaEvent`: o que está em disputa aqui é o valor da prévia para um
 * payload dado, e o caminho de produção usa exatamente esta função nos dois
 * ramos (inbound `:1039`, outbound `:1479`). O dublê de banco seria ruído —
 * nenhuma das asserções depende de linha gravada.
 */

const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Maria Silva",
  "TEL;type=CELL;type=VOICE;waid=5511968914004:+55 11 96891-4004",
  "END:VCARD",
].join("\n");

function payload(p: Partial<WahaPayload>): WahaPayload {
  return { ...p } as WahaPayload;
}

describe("previewFromMessage — prévia de vCard na lista da Inbox (#2742)", () => {
  it("NOWEB sem body: lê o vCard do contactMessage e mostra o nome, não [contact]", () => {
    const p = payload({
      id: "false_5511968914004_3EB0CCC",
      _data: { message: { contactMessage: { vcard: VCARD, displayName: "Maria Silva" } } },
    });
    const previa = previewFromMessage(p);
    expect(previa).toBe("Contato: Maria Silva");
    expect(previa).not.toContain("[contact]");
    expect(previa).not.toContain("BEGIN:VCARD");
  });

  it("legado com body = cartão cru: o texto do vCard NÃO vira prévia", () => {
    const p = payload({ id: "false_5511968914004_3EB0DDD", type: "vcard", body: VCARD });
    expect(previewFromMessage(p)).toBe("Contato: Maria Silva");
  });

  it("cartão sem FN legível cai no rótulo de tipo e nunca vaza BEGIN:VCARD", () => {
    const ilegivel = "BEGIN:VCARD\nVERSION:3.0\nEND:VCARD";
    const p = payload({
      id: "false_5511968914004_3EB0EEE",
      _data: { message: { contactMessage: { vcard: ilegivel } } },
    });
    expect(previewFromMessage(p)).toBe("[contact]");
  });

  it("contact sem cartão usa o displayName com o mesmo rótulo", () => {
    const p = payload({
      id: "false_5511968914004_3EB0FFF",
      _data: { message: { contactMessage: { displayName: "João da Silva" } } },
    });
    expect(previewFromMessage(p)).toBe("Contato: João da Silva");
  });

  it("texto segue texto: corpo cortado em 280", () => {
    const p = payload({ id: "m1", body: "x".repeat(400) });
    expect(previewFromMessage(p)).toBe("x".repeat(280));
  });

  it("legenda de mídia continua sendo o corpo, não [image]", () => {
    const p = payload({
      id: "m2",
      body: "olha essa foto",
      _data: { message: { imageMessage: {} } },
    });
    expect(previewFromMessage(p)).toBe("olha essa foto");
  });

  it("mídia sem corpo continua com o rótulo de tipo (comportamento anterior)", () => {
    const p = payload({ id: "m3", _data: { message: { imageMessage: {} } } });
    expect(previewFromMessage(p)).toBe("[image]");
  });
});
