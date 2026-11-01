import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { NOTIFY_KINDS } from "./kinds";
import { corpoDoAvisoDeMensagem, montarPayloadDeInbound, truncar } from "./push_payload";

describe("push_payload", () => {
  it("trunca corpo longo", () => {
    expect(truncar("a".repeat(141)).endsWith("…")).toBe(true);
    expect(truncar("oi").length).toBe(2);
  });

  it("monta título com marca e href da conversa", () => {
    const p = montarPayloadDeInbound({
      brand: "Clínica",
      conversationId: "c1",
      preview: "olá",
    });
    expect(p.title).toBe("Nova mensagem");
    expect(p.href).toBe("/app/inbox?id=c1");
    expect(p.tag).toBe(`${NOTIFY_KINDS.message_inbound.tagPrefix}:c1`);
    expect(p.body).toBe("olá");
  });

  it("usa o nome do contato no título quando informado", () => {
    const p = montarPayloadDeInbound({
      brand: "Clínica",
      conversationId: "c1",
      preview: "olá",
      contactName: "Maria",
    });
    expect(p.title).toBe("Maria");
  });

  /**
   * O aviso da página e o push do servidor só se substituem na bandeja quando a
   * tag é a MESMA. As duas pontas montam a tag do mesmo prefixo de
   * `kinds.ts`; um literal aqui voltaria a poder divergir em silêncio.
   */
  it("as tags do push saem do prefixo de kinds.ts, nunca de literal", () => {
    for (const arquivo of ["push_payload.ts", "push.handler.ts"]) {
      const fonte = readFileSync(`lib/notifications/${arquivo}`, "utf8");
      expect(fonte, arquivo).not.toMatch(/tag:\s*`(msg|mention|lead-(assigned|won|lost)):/);
      expect(fonte, arquivo).not.toMatch(/`msg:\$\{/);
    }
  });

  it("repassa o corpo sem prévia declarado pelo produtor", () => {
    const p = montarPayloadDeInbound({ brand: "x", conversationId: "c1", preview: "olá", corpoSemPrevia: "Nova mensagem" });
    expect(p.corpoSemPrevia).toBe("Nova mensagem");
  });
});

describe("corpoDoAvisoDeMensagem", () => {
  it("texto: a prévia truncada no corpo e 'Nova mensagem' sem prévia", () => {
    expect(corpoDoAvisoDeMensagem("text", "  olá  ")).toEqual({ body: "olá", corpoSemPrevia: "Nova mensagem" });
    expect(corpoDoAvisoDeMensagem("text", "a".repeat(200)).body.endsWith("…")).toBe(true);
  });

  it("texto vazio vira 'Nova mensagem'", () => {
    expect(corpoDoAvisoDeMensagem("text", "   ")).toEqual({ body: "Nova mensagem", corpoSemPrevia: "Nova mensagem" });
    expect(corpoDoAvisoDeMensagem("text", null).body).toBe("Nova mensagem");
  });

  it.each([
    ["audio", "Áudio"],
    ["image", "Imagem"],
    ["video", "Vídeo"],
    ["document", "Documento"],
    ["sticker", "Figurinha"],
    ["location", "Localização compartilhada"],
    ["contact", "Contato"],
  ])("%s diz o tipo nos dois campos, nunca 'Mídia' nem a legenda", (tipo, rotulo) => {
    expect(corpoDoAvisoDeMensagem(tipo, "legenda da foto")).toEqual({ body: rotulo, corpoSemPrevia: rotulo });
  });

  it.each(["template", "desconhecido"])("%s vira 'Nova mensagem'", (tipo) => {
    expect(corpoDoAvisoDeMensagem(tipo, "x")).toEqual({ body: "Nova mensagem", corpoSemPrevia: "Nova mensagem" });
  });
});
