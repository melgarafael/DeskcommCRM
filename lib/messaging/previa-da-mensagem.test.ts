import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import { previaDaMensagem, ROTULO_DO_TIPO } from "@/lib/messaging/previa-da-mensagem";

/**
 * A prévia da lista da Inbox para os tipos SEM corpo (#2742, item 2).
 *
 * O #2765 consertou o vCard (a prévia virou `Contato: <nome>`); o que sobrava é
 * o terceiro item do enunciado: "o mesmo cuidado para `[image]`, `[audio]` etc.".
 * Antes, todo tipo sem `body` caía em `` `[${tipo}]` `` e a lista mostrava o
 * vocabulário do wire em inglês. Agora cada tipo tem o MESMO rótulo em português
 * que o balão da conversa usa — e o rótulo é uma chave do dicionário de espanhol,
 * porque a tela já o mostra.
 *
 * ⚠️ Estes casos entram pela FUNÇÃO PURA (`previaDaMensagem`), que é a régua que
 * a conversa individual e a de grupo consomem. O caminho de ponta a ponta dos
 * dois tem teste próprio ao lado da ingestão de cada um (`ingest-preview.test.ts`
 * e o teste do ingest de grupo).
 */

describe("previaDaMensagem — prévia dos tipos sem corpo (#2742)", () => {
  it("todo tipo com rótulo mapeado devolve o rótulo, e nunca o literal em inglês", () => {
    for (const [tipo, rotulo] of Object.entries(ROTULO_DO_TIPO)) {
      const previa = previaDaMensagem(null, tipo);
      expect(previa, `prévia de "${tipo}"`).toBe(rotulo);
      expect(previa).not.toContain("[");
    }
  });

  it("cobre os tipos que a ingestão pode gravar sem corpo", () => {
    // A lista é a superfície que a issue nomeia: imagem, áudio, vídeo, documento,
    // figurinha, localização e contato compartilhado — mais a reação, que é o
    // outro tipo que chega sem corpo e virava `[reaction]`.
    for (const tipo of [
      "image",
      "audio",
      "video",
      "document",
      "sticker",
      "location",
      "contact",
      "reaction",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(ROTULO_DO_TIPO, tipo), tipo).toBe(true);
    }
  });

  it("cada rótulo é uma chave do dicionário COM tradução em espanhol", () => {
    // "PT no mapa e ES no dicionário": a palavra da prévia é a mesma que a tela
    // mostra, e quem escolheu espanhol não pode ver português cru. Rótulo novo
    // sem `es` reprova AQUI, antes de virar texto na lista.
    for (const rotulo of Object.values(ROTULO_DO_TIPO)) {
      const entrada = DICIONARIO[rotulo];
      expect(entrada, `rótulo "${rotulo}" fora do dicionário`).toBeDefined();
      expect(entrada?.es, `rótulo "${rotulo}" sem espanhol`).toBeTruthy();
    }
  });

  it("texto sem corpo é vazio (a lista põe 'Sem mensagens'), não um rótulo", () => {
    expect(previaDaMensagem(null, "text")).toBe("");
    expect(previaDaMensagem(undefined, "text")).toBe("");
  });

  it("tipo desconhecido não vira vazio nem quebra: devolve o token entre colchetes", () => {
    const previa = previaDaMensagem(null, "canal_novo_qualquer");
    expect(previa).toBe("[canal_novo_qualquer]");
    expect(previa.length).toBeGreaterThan(0);
  });

  it("corpo tem precedência sobre o tipo: legenda de mídia continua sendo o corpo", () => {
    expect(previaDaMensagem("olha essa foto", "image")).toBe("olha essa foto");
    expect(previaDaMensagem("segue o arquivo", "document")).toBe("segue o arquivo");
  });

  it("vCard com nome legível vira 'Contato: <nome>'; ilegível cai no rótulo, nunca no cartão cru", () => {
    const cartao = "BEGIN:VCARD\nVERSION:3.0\nFN:Maria Silva\nEND:VCARD";
    expect(previaDaMensagem(cartao, "contact")).toBe("Contato: Maria Silva");
    const ilegivel = "BEGIN:VCARD\nVERSION:3.0\nEND:VCARD";
    const previa = previaDaMensagem(ilegivel, "contact");
    expect(previa).toBe("Contato");
    expect(previa).not.toContain("BEGIN:VCARD");
  });

  it("o teto da coluna continua valendo (280)", () => {
    expect(previaDaMensagem("x".repeat(400), "text")).toBe("x".repeat(280));
  });
});
