import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import fixture from "@/lib/waha/__fixtures__/acervo-noweb-2026.7.2.json";
import { externalIdDeEntrada, externalIdDeSaida, type WahaPayload } from "@/lib/waha/ingest";
import { candidatosDeExternalId, identidadeDoChat, mapearMensagemDoAcervo } from "@/lib/channels/historico/mapear";

const ctx = { orgId: "org-1", sessionId: "sess-1", contactId: "ct-1", conversationId: "cv-1" };
const msgs = fixture.messages as unknown as Record<string, WahaPayload[]>;
const porId = (id: string): WahaPayload => {
  const m = Object.values(msgs).flat().find((x) => x.id?.endsWith(`_${id}`));
  if (!m) throw new Error(`fixture sem ${id}`);
  return m;
};

describe("mapearMensagemDoAcervo", () => {
  it("entrada: external_id é o mesmo que o caminho ao vivo grava", () => {
    const p = porId("AAA001");
    const l = mapearMensagemDoAcervo(p, ctx);
    expect(l.external_id).toBe("false_222222222222222@lid_AAA001");
    expect(l.external_id).toBe(externalIdDeEntrada(p));
    expect(l.direction).toBe("inbound");
    expect(l.status).toBe("delivered");
    expect(l.sent_via).toBe("external_device");
    expect(l.body).toBe("Oi, tudo bem?");
    expect(l.type).toBe("text");
    expect(l.metadata).toEqual({ historico_importado: "true" });
  });

  it("saída: external_id bare, igual ao do caminho ao vivo", () => {
    const p = porId("AAA002");
    const l = mapearMensagemDoAcervo(p, ctx);
    expect(l.external_id).toBe(externalIdDeSaida(p));
    expect(l.external_id).toBe("AAA002");
    expect(l.direction).toBe("outbound");
    expect(l.status).toBe("sent");
  });

  it("sent_at é o ISO do timestamp", () => {
    const p = porId("AAA001");
    expect(mapearMensagemDoAcervo(p, ctx).sent_at).toBe(new Date(1760000100 * 1000).toISOString());
  });

  it("ids do contexto vão para as colunas", () => {
    const l = mapearMensagemDoAcervo(porId("AAA001"), ctx);
    expect(l.organization_id).toBe("org-1");
    expect(l.channel_session_id).toBe("sess-1");
    expect(l.contact_id).toBe("ct-1");
    expect(l.conversation_id).toBe("cv-1");
  });

  it("imagem e áudio ficam pendentes de mídia", () => {
    const img = mapearMensagemDoAcervo(porId("AAA003"), ctx);
    expect(img.type).toBe("image");
    expect(img.media_mime).toBe("image/jpeg");
    expect(img.body).toBeNull();
    expect(img.metadata.media_status).toBe("pendente");
    const aud = mapearMensagemDoAcervo(porId("AAA004"), ctx);
    expect(aud.type).toBe("audio");
    expect(aud.metadata.media_status).toBe("pendente");
  });

  it.each([
    ["video", "video/mp4"],
    ["document", "application/pdf"],
    ["sticker", "image/webp"],
  ])("%s fica fora do escopo", (tipo, mime) => {
    const p = {
      ...porId("AAA003"),
      type: tipo,
      media: { url: null, mimetype: mime, filename: null },
    } as unknown as WahaPayload;
    const l = mapearMensagemDoAcervo(p, ctx);
    expect(l.type).toBe(tipo);
    expect(l.metadata.media_status).toBe("fora_do_escopo");
    expect(l.metadata.historico_importado).toBe("true");
  });

  it("historico_importado é 'true' em toda linha", () => {
    for (const p of Object.values(msgs).flat()) {
      expect(mapearMensagemDoAcervo(p, ctx).metadata.historico_importado).toBe("true");
    }
  });
});

describe("identidadeDoChat", () => {
  it("telefone", () => {
    const i = identidadeDoChat(porId("AAA003"));
    expect(i).toMatchObject({ kind: "phone", phone: "+5511900000001", lid: null });
    expect(i.chatId).toBe("5511900000001@s.whatsapp.net");
  });

  it("@lid com remoteJidAlt devolve o telefone", () => {
    const i = identidadeDoChat(porId("BBB001"));
    expect(i.kind).toBe("lid");
    expect(i.lid).toBe("111111111111111");
    expect(i.phone).toBe("+5511900000002");
  });

  it("saída: o chat vem do id, não do from (que é o número do operador)", () => {
    const i = identidadeDoChat(porId("BBB002"));
    expect(i.chatId).toBe("111111111111111@lid");
    expect(i.phone).toBe("+5511900000002");
    const o = identidadeDoChat(porId("AAA002"));
    expect(o).toMatchObject({ kind: "lid", lid: "222222222222222", phone: "+5511900000001" });
  });
});

describe("candidatosDeExternalId", () => {
  it("entrada @s.whatsapp.net: completo, variante @c.us e bare", () => {
    const c = candidatosDeExternalId(porId("AAA003"));
    expect(c[0]).toBe("false_5511900000001@s.whatsapp.net_AAA003");
    expect(c).toContain("false_5511900000001@c.us_AAA003");
    expect(c).toContain("AAA003");
    expect(new Set(c).size).toBe(c.length);
  });

  it("entrada @c.us: variante @s.whatsapp.net", () => {
    const p = { ...porId("AAA003"), id: "false_5511900000001@c.us_AAA003" } as WahaPayload;
    const c = candidatosDeExternalId(p);
    expect(c).toContain("false_5511900000001@s.whatsapp.net_AAA003");
    expect(c).toContain("false_5511900000001@c.us_AAA003");
  });

  it("entrada @lid: completo e bare, sem variantes de telefone", () => {
    const c = candidatosDeExternalId(porId("AAA001"));
    expect(c).toEqual(["false_222222222222222@lid_AAA001", "AAA001"]);
  });

  it("saída: bare primeiro, e o completo", () => {
    const c = candidatosDeExternalId(porId("AAA002"));
    expect(c[0]).toBe("AAA002");
    expect(c).toContain("true_222222222222222@lid_AAA002");
  });
});
