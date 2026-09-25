import { afterEach, describe, expect, it, vi } from "vitest";
import { WahaClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("edição e revogação no WAHA", () => {
  it("escapa o chat e o id completo sem enviar o texto em URL", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WahaClient("http://waha", "segredo");

    await client.editMessage("sessão 1", "123@c.us", "true_123@c.us_ABC", "novo texto");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://waha/api/sess%C3%A3o%201/chats/123%40c.us/messages/true_123%40c.us_ABC");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ text: "novo texto" });
    expect(init.headers).toMatchObject({ "X-Api-Key": "segredo" });
  });

  it("apaga a mensagem individual e propaga a recusa do canal", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WahaClient("http://waha", "segredo");
    await expect(client.deleteMessage("s", "123@lid", "true_123@lid_ABC"))
      .rejects.toThrow("waha_403");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://waha/api/s/chats/123%40lid/messages/true_123%40lid_ABC");
    expect(init.method).toBe("DELETE");
  });
});
