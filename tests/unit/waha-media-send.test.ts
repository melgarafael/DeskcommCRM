import { describe, expect, it } from "vitest";

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
