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
    expect(previewFromMessage(p)).toBe("Contato");
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

  it("mídia sem corpo mostra o rótulo do tipo em português, não o literal em inglês (#2742)", () => {
    const p = payload({ id: "m3", _data: { message: { imageMessage: {} } } });
    expect(previewFromMessage(p)).toBe("Imagem");
  });

  it("cada tipo sem corpo ganha o rótulo em português que o balão já usa (#2742)", () => {
    // O tipo pode chegar pelo `type` cru do canal OU pela chave de `_data.message`
    // do NOWEB — os dois caminhos resolvem no mesmo tipo do CRM, e a prévia é a
    // MESMA palavra que o balão da conversa mostra para ele.
    const casos: [Partial<WahaPayload>, string][] = [
      [{ type: "audio" }, "Áudio"],
      [{ type: "ptt" }, "Áudio"],
      [{ _data: { message: { videoMessage: {} } } }, "Vídeo"],
      [{ type: "document" }, "Documento"],
      [{ _data: { message: { stickerMessage: {} } } }, "Figurinha"],
      [{ type: "location" }, "Localização compartilhada"],
      [{ type: "reaction" }, "Reação"],
    ];
    for (const [parcial, esperado] of casos) {
      const p = payload({ id: `t-${esperado}`, ...parcial });
      expect(previewFromMessage(p), `prévia de ${JSON.stringify(parcial)}`).toBe(esperado);
    }
  });

  it("tipo cru desconhecido degrada para texto: a lista mostra 'Sem mensagens', não quebra (#2742)", () => {
    // O mapa do wire trata tipo cru desconhecido como texto (de propósito: não
    // perder a mensagem), então a prévia sai vazia e a lista cai no "Sem
    // mensagens". O que NÃO pode — e a régua do módulo garante — é a prévia
    // virar `null` ou estourar. O caso do tipo DESCONHECIDO que não degrada (tipo
    // de CRM sem rótulo) tem teste próprio em `lib/messaging/previa-da-mensagem`.
    const p = payload({ id: "m4", type: "zapzap_misterioso" });
    expect(previewFromMessage(p)).toBe("");
  });
});
