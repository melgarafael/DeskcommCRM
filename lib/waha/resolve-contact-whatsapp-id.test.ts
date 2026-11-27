import { beforeEach, describe, expect, it, vi } from "vitest";

import { wahaContactPayload } from "@/lib/waha/contact-card";
import {
  limparMemoCheckExists,
  numeroTemContaNoWhatsapp,
  resolveCanonicalCusChatId,
  resolveWhatsappIdForContactCard,
  sendChatIdFromCheckResult,
  whatsappIdFromCheckResult,
} from "@/lib/waha/resolve-contact-whatsapp-id";


beforeEach(() => limparMemoCheckExists());

describe("whatsappIdFromCheckResult", () => {
  it("prefere pn sobre chatId", () => {
    expect(
      whatsappIdFromCheckResult({
        numberExists: true,
        pn: "553198966398@c.us",
        chatId: "100000000000001@lid",
      }),
    ).toBe("553198966398");
  });

  it("extrai dígitos de chatId @c.us", () => {
    expect(
      whatsappIdFromCheckResult({
        numberExists: true,
        chatId: "5531998966398@c.us",
      }),
    ).toBe("5531998966398");
  });
});

describe("sendChatIdFromCheckResult", () => {
  it("envia para o @lid que o WAHA devolveu, não para o telefone @c.us", () => {
    expect(
      sendChatIdFromCheckResult({
        numberExists: true,
        chatId: "23423462304912@lid",
        pn: "5532984793302@c.us",
      }),
    ).toBe("23423462304912@lid");
  });
});

describe("resolveWhatsappIdForContactCard", () => {
  it("tenta variantes BR e usa a primeira que existir", async () => {
    const client = {
      checkContactExists: vi
        .fn()
        .mockResolvedValueOnce({ numberExists: false })
        .mockResolvedValueOnce({ numberExists: true, pn: "553198966398@c.us" }),
    };

    const id = await resolveWhatsappIdForContactCard(
      client as never,
      "sessao-1",
      "+5531998966398",
    );

    expect(id).toBe("553198966398");
    expect(client.checkContactExists).toHaveBeenCalledTimes(2);
  });

  it("retorna null quando nenhuma variante existe", async () => {
    const client = {
      checkContactExists: vi.fn().mockResolvedValue({ numberExists: false }),
    };

    const id = await resolveWhatsappIdForContactCard(
      client as never,
      "sessao-1",
      "+5531998966398",
    );

    expect(id).toBeNull();
  });
});

describe("resolveCanonicalCusChatId", () => {
  it("não consulta lid nem grupo", async () => {
    const client = { checkContactExists: vi.fn() };
    await expect(
      resolveCanonicalCusChatId(client as never, "s", "12345@lid"),
    ).resolves.toBe("12345@lid");
    await expect(
      resolveCanonicalCusChatId(client as never, "s", "x@g.us"),
    ).resolves.toBe("x@g.us");
    expect(client.checkContactExists).not.toHaveBeenCalled();
  });

  it("troca o chatId quando o WhatsApp só conhece a variante sem o nono", async () => {
    const client = {
      checkContactExists: vi
        .fn()
        .mockResolvedValueOnce({ numberExists: false })
        .mockResolvedValueOnce({ numberExists: true, pn: "553198966398@c.us" }),
    };
    await expect(
      resolveCanonicalCusChatId(client as never, "s", "5531998966398@c.us"),
    ).resolves.toBe("553198966398@c.us");
  });

  it("troca o chatId quando o WhatsApp só conhece a variante COM o nono", async () => {
    const client = {
      checkContactExists: vi
        .fn()
        .mockResolvedValueOnce({ numberExists: false })
        .mockResolvedValueOnce({ numberExists: true, chatId: "5531998966398@c.us" }),
    };
    await expect(
      resolveCanonicalCusChatId(client as never, "s", "553198966398@c.us"),
    ).resolves.toBe("5531998966398@c.us");
  });

  it("lead novo: usa o @lid do check-exists (caso +5532984793302)", async () => {
    const client = {
      checkContactExists: vi.fn().mockResolvedValue({
        numberExists: true,
        chatId: "23423462304912@lid",
        pn: "5532984793302@c.us",
      }),
    };
    await expect(
      resolveCanonicalCusChatId(client as never, "s", "5532984793302@c.us"),
    ).resolves.toBe("23423462304912@lid");
  });
});

describe("wahaContactPayload com wa_id resolvido", () => {
  it("alinha phoneNumber e waid ao id canônico de 12 dígitos", () => {
    const p = wahaContactPayload("Maria", "+5531998966398", "553198966398");
    expect(p.whatsappId).toBe("553198966398");
    expect(p.phoneNumber).toBe("+553198966398");
    expect(p.vcard).toContain("waid=553198966398");
    expect(p.vcard).toContain("+553198966398");
  });
});


describe("consulta de existência em três estados", () => {
  it("só recusa quando TODAS as grafias responderam false", async () => {
    const client = { checkContactExists: vi.fn().mockResolvedValue({ numberExists: false }) };
    expect(await numeroTemContaNoWhatsapp(client as never, "s", "5532984793302")).toBe(false);
    expect(client.checkContactExists).toHaveBeenCalledTimes(2);
  });
  it("uma falha e nenhum positivo preservam desconhecido e o envio original", async () => {
    const client = { checkContactExists: vi.fn().mockRejectedValueOnce(Error("rede")).mockResolvedValue({ numberExists: false }) };
    expect(await numeroTemContaNoWhatsapp(client as never, "s", "5532984793302")).toBeNull();
    client.checkContactExists.mockRejectedValue(Error("rede"));
    expect(await resolveCanonicalCusChatId(client as never, "s", "5532984793302@c.us")).toBe("5532984793302@c.us");
  });
  it("positivo prevalece depois de uma falha e a pré-consulta é reutilizada no envio", async () => {
    const client = { checkContactExists: vi.fn().mockRejectedValueOnce(Error("rede")).mockResolvedValueOnce({ numberExists: true, chatId: "1234567890@lid" }) };
    expect(await numeroTemContaNoWhatsapp(client as never, "s", "5532984793302")).toBe(true);
    expect(await resolveCanonicalCusChatId(client as never, "s", "5532984793302@c.us")).toBe("1234567890@lid");
    expect(client.checkContactExists).toHaveBeenCalledTimes(2);
  });
  it("resposta ilegível e entrada sem grafia não viram inexistência definitiva", async () => {
    const client = { checkContactExists: vi.fn().mockResolvedValue({}) };
    expect(await numeroTemContaNoWhatsapp(client as never, "s", "12025550123")).toBeNull();
    expect(await numeroTemContaNoWhatsapp(client as never, "s", "")).toBeNull();
  });
});
