import { describe, expect, it } from "vitest";

import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { wahaSendPlanFor } from "@/lib/waha/media-send";

const media = { url: "https://signed.example/x?token=t", mime: "image/jpeg", filename: "x.jpg", caption: "oi" };

describe("wahaSendPlanFor", () => {
  it("image → sendImage com caption", () => {
    const plan = wahaSendPlanFor("image", media);
    expect(plan.endpoint).toBe("sendImage");
    expect(plan.payload.caption).toBe("oi");
    expect((plan.payload.file as { url: string }).url).toBe(media.url);
  });
  it("video → sendVideo com caption e convert", () => {
    const plan = wahaSendPlanFor("video", { ...media, mime: "video/mp4" });
    expect(plan.endpoint).toBe("sendVideo");
    expect(plan.payload.convert).toBe(true);
  });
  it("audio → sendVoice com convert (WhatsApp exige OGG/OPUS)", () => {
    const plan = wahaSendPlanFor("audio", { ...media, mime: "audio/webm;codecs=opus" });
    expect(plan.endpoint).toBe("sendVoice");
    expect(plan.payload.convert).toBe(true);
    expect(plan.payload.caption).toBeUndefined(); // voz não tem caption no WhatsApp
  });
  it("document (e desconhecidos) → sendFile com filename", () => {
    const plan = wahaSendPlanFor("document", { ...media, mime: "application/pdf", filename: "doc.pdf" });
    expect(plan.endpoint).toBe("sendFile");
    expect((plan.payload.file as { filename: string }).filename).toBe("doc.pdf");
  });
});

describe("isMediaPathOwnedBy", () => {
  const orgId = "org-1";
  const conversationId = "conv-1";

  it("path da própria org/conversa → true", () => {
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(true);
  });
  it("org diferente → false", () => {
    expect(isMediaPathOwnedBy(`org-2/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(false);
  });
  it("conversa diferente → false", () => {
    expect(isMediaPathOwnedBy(`${orgId}/conv-2/foo.jpg`, orgId, conversationId)).toBe(false);
  });
  it("confusão de prefixo (org-1x/...) → false", () => {
    expect(isMediaPathOwnedBy(`${orgId}x/${conversationId}/foo.jpg`, orgId, conversationId)).toBe(false);
  });

  it("recusa caminho que sai da pasta da conversa por `..`, `.`, segmento vazio ou barra invertida", () => {
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/../conv-2/foo.jpg`, orgId, conversationId)).toBe(false);
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/../../org-2/conv-9/foo.jpg`, orgId, conversationId)).toBe(false);
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/./foo.jpg`, orgId, conversationId)).toBe(false);
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}//foo.jpg`, orgId, conversationId)).toBe(false);
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/..\\org-2\\foo.jpg`, orgId, conversationId)).toBe(false);
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/`, orgId, conversationId)).toBe(false);
    // Controle: subpasta e nome com ponto continuam valendo.
    expect(isMediaPathOwnedBy(`${orgId}/${conversationId}/2026/foto..final.jpg`, orgId, conversationId)).toBe(true);
  });
});
describe("isMediaPathOwnedBy — o que o Storage normaliza não passa (#5034)", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const CONV = "44444444-4444-4444-8444-444444444444";
  it.each([
    `${ORG}/${CONV}/%2e%2e/%2e%2e/outra-org/segredo.pdf`,
    `${ORG}/${CONV}/%2E%2E/x.pdf`,
    `${ORG}/${CONV}/a?b.pdf`,
    `${ORG}/${CONV}/a#b.pdf`,
    `${ORG}/${CONV}/x.pdf `,
  ])("recusa %s", (path) => {
    expect(isMediaPathOwnedBy(path, ORG, CONV)).toBe(false);
  });

  it("o caminho que o upload gera continua valendo", () => {
    expect(isMediaPathOwnedBy(`${ORG}/${CONV}/out-0b8d3c2e.pdf`, ORG, CONV)).toBe(true);
  });
});

