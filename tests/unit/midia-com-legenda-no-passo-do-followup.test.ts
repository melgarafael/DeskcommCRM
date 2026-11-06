/**
 * MÍDIA COM LEGENDA NO PASSO DE MENSAGEM DO FOLLOW-UP (#2734) — o CONTRATO.
 *
 * ═══ Por que este arquivo existe ═══
 *
 * Dois contratos do follow-up mudam com esta entrega, e os dois são de forma:
 *
 *  1. `classificarMidiaComLegenda` — a régua de tipo que a automação E o
 *     follow-up consultam. Ela é o único lugar onde o corte mora; o #2972 a
 *     ampliou para áudio, vídeo e documento qualquer (o `.docx`/`.xlsx` deixou
 *     de ser recusado, que era o que empurrava o operador ao script externo).
 *  2. `actionConfigSchema` (modo `text`) — o `media_url` opcional. "Opcional" é a
 *     metade que protege o que já está publicado: os grafos em produção NÃO têm a
 *     chave, e um campo obrigatório os invalidaria no próximo save do editor.
 *
 * O `strictObject` do schema é o par do primeiro: `media_url` no modo `ai_message`
 * (onde quem escreve é o modelo, e a mídia não tem de quem ser legenda) precisa ser
 * RECUSADO, não ignorado em silêncio.
 */
import { describe, expect, it } from "vitest";

import { corpoDoEnvio } from "@/lib/agent-engine/edge/crm/send-message";
import { actionConfigSchema } from "@/lib/followup/graph-schema";
import { classificarMidiaComLegenda } from "@/lib/messaging/media/midia-com-legenda";

describe("classificarMidiaComLegenda — imagem, vídeo, áudio e documento", () => {
  it("aceita o que o Inbox aceita como imagem", () => {
    expect(classificarMidiaComLegenda("https://cdn.exemplo/a.jpg")).toEqual({
      ok: true,
      type: "image",
      mime: "image/jpeg",
    });
    expect(classificarMidiaComLegenda("https://cdn.exemplo/a.jpeg")).toMatchObject({ type: "image" });
    expect(classificarMidiaComLegenda("https://cdn.exemplo/a.PNG")).toMatchObject({ type: "image", mime: "image/png" });
    expect(classificarMidiaComLegenda("https://cdn.exemplo/a.webp")).toMatchObject({ type: "image" });
    expect(classificarMidiaComLegenda("https://cdn.exemplo/a.gif")).toMatchObject({ type: "image" });
  });

  it("aceita PDF — e o classifica como `document`, que é o tipo que o handler espera", () => {
    expect(classificarMidiaComLegenda("https://cdn.exemplo/contrato.pdf")).toEqual({
      ok: true,
      type: "document",
      mime: "application/pdf",
    });
  });

  it("o MIME declarado vence a extensão", () => {
    // Quem declarou o tipo sabe mais que o nome do arquivo: um `.jpg` servido como
    // `application/pdf` sairia como imagem quebrada se a extensão decidisse.
    expect(classificarMidiaComLegenda("https://cdn.exemplo/a.jpg", "application/pdf")).toEqual({
      ok: true,
      type: "document",
      mime: "application/pdf",
    });
    expect(classificarMidiaComLegenda("https://cdn.exemplo/a.pdf", "image/png")).toMatchObject({ type: "image" });
  });

  it("aceita documento que NÃO é PDF — planilha, docx, zip e csv saem como `document`", () => {
    // #2972: era aqui que o `.xlsx` de preços e o `.docx` de contrato paravam de
    // propósito, o que devolvia o operador ao script externo que a issue aposenta.
    // Eles passam por `kindFromMime` como `document` e saem por `sendFile`.
    for (const url of [
      "https://cdn.exemplo/custos.xlsx",
      "https://cdn.exemplo/contrato.docx",
      "https://cdn.exemplo/pacote.zip",
      "https://cdn.exemplo/dados.csv",
    ]) {
      expect(classificarMidiaComLegenda(url), url).toMatchObject({ ok: true, type: "document" });
    }
  });

  it("recusa o que não é mídia identificável: sem extensão, extensão desconhecida, URL inválida", () => {
    // A URL que já passou pelo schema do editor é válida; estes casos chegam por
    // payload de job gravado antes da régua, e recusar é o desfecho que não mente.
    for (const url of [
      "https://cdn.exemplo/arquivo",
      "https://cdn.exemplo/relatorio.qzx",
      "nao-e-url",
      "https://cdn.exemplo/",
    ]) {
      expect(classificarMidiaComLegenda(url).ok, url).toBe(false);
    }
  });

  it("query string e âncora não escondem a extensão", () => {
    expect(classificarMidiaComLegenda("https://cdn.exemplo/oferta.png?v=3")).toMatchObject({ type: "image" });
    expect(classificarMidiaComLegenda("https://cdn.exemplo/oferta.pdf#pagina=2")).toMatchObject({ type: "document" });
  });
});

describe("actionConfigSchema (modo `text`) — `media_url` opcional", () => {
  it("sem `media_url` continua válido: é o que está publicado hoje", () => {
    const r = actionConfigSchema.safeParse({ mode: "text", body: "Oi! Tudo bem?" });
    expect(r.success).toBe(true);
  });

  it("com `media_url` de imagem ou PDF, aceita", () => {
    for (const media_url of ["https://cdn.exemplo/a.png", "https://cdn.exemplo/a.pdf"]) {
      const r = actionConfigSchema.safeParse({ mode: "text", body: "Olha isso.", media_url });
      expect(r.success, media_url).toBe(true);
    }
  });

  it("recusa `media_url` que não é URL — a tela não grava lixo que o runtime descarta", () => {
    const r = actionConfigSchema.safeParse({ mode: "text", body: "Olha isso.", media_url: "caminho/relativo.png" });
    expect(r.success).toBe(false);
  });

  it("`strictObject`: `media_url` no modo `ai_message` é recusado, não ignorado", () => {
    // Quem escreve ali é o modelo; não existe "o texto vira legenda" no modo IA, e
    // aceitar a chave em silêncio faria o operador acreditar que a mídia sai.
    const r = actionConfigSchema.safeParse({
      mode: "ai_message",
      prompt_hint: "Fale do catálogo.",
      media_url: "https://cdn.exemplo/a.png",
    });
    expect(r.success).toBe(false);
  });
});

describe("corpoDoEnvio — a mídia do passo chega ao handler como MÍDIA, não como texto", () => {
  const base = {
    tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
    leadId: "lead",
    jobId: "job",
    seq: 1,
    conversationId: "cccccccc-0000-4000-8000-000000000001",
  };

  it("url de imagem: `type: image` + `media_url` + mime, e a legenda no body", () => {
    // Este é o caminho do WORKER do follow-up (`channel.send` → `sendTurnMessage` →
    // `sendMessageHandler`). Se a URL não fosse mapeada aqui, o passo "com mídia"
    // mandaria só a legenda — exatamente o "texto solto" que a entrega proíbe.
    expect(
      corpoDoEnvio(
        { ...base, body: "legenda", media: { url: "https://cdn.exemplo/a.png", mime: "image/png", type: "image" } },
        "k",
      ),
    ).toEqual({
      conversation_id: base.conversationId,
      type: "image",
      media_url: "https://cdn.exemplo/a.png",
      media_mime: "image/png",
      body: "legenda",
      metadata: { idempotency_key: "k" },
    });
  });

  it("url de PDF: `type: document` — o tipo vem decidido, não é sempre `image`", () => {
    expect(
      corpoDoEnvio(
        { ...base, body: "segue", media: { url: "https://cdn.exemplo/a.pdf", mime: "application/pdf", type: "document" } },
        "k",
      ),
    ).toMatchObject({ type: "document", media_url: "https://cdn.exemplo/a.pdf", media_mime: "application/pdf" });
  });

  it("o caminho ANTIGO do Storage (foto do catálogo) continua idêntico", () => {
    expect(
      corpoDoEnvio({ ...base, body: "legenda", media: { storagePath: "p.jpg", mime: "image/jpeg" } }, "k"),
    ).toMatchObject({ type: "image", media_storage_path: "p.jpg", media_mime: "image/jpeg" });
  });
});
