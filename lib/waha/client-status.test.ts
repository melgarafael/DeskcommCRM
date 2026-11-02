/**
 * O envelope HTTP da publicação de Status (#3397).
 *
 * O teste da camada de cima prova que o ADAPTER monta o público em JID; este
 * prova o que o CLIENTE manda no fio — caminho, corpo e a ausência de `contacts`
 * quando o público é o número inteiro. Foi a parte que o #2668 nunca mediu: lá
 * o teste olhava o handler, e o corpo enviado ao provedor era suposição.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WahaClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

/** Dublê de `fetch` que guarda a chamada e responde como o provedor. */
function provedorQueResponde(status = 201, corpo: unknown = { id: { id: "ST-1" } }) {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit) => {
      chamadas.push({ url: String(url), init });
      return new Response(JSON.stringify(corpo), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return chamadas;
}

describe("WahaClient.sendStatusImage", () => {
  it("posta no endpoint do Status com o arquivo, a legenda e o público em JID", async () => {
    const chamadas = provedorQueResponde();
    const cliente = new WahaClient("http://waha.local", "chave");

    const resposta = await cliente.sendStatusImage("loja", {
      mimetype: "image/jpeg",
      data: "QUJD",
      caption: "Promo",
      contacts: ["5515999999999@c.us"],
    });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("http://waha.local/api/loja/status/image");
    expect(chamadas[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(chamadas[0]!.init.body))).toEqual({
      file: { mimetype: "image/jpeg", filename: "status", data: "QUJD" },
      caption: "Promo",
      contacts: ["5515999999999@c.us"],
    });
    expect(resposta).toEqual({ id: { id: "ST-1" } });
  });

  it("público 'todos' NÃO manda `contacts` — no provedor, sem lista é o número inteiro", async () => {
    const chamadas = provedorQueResponde();
    const cliente = new WahaClient("http://waha.local", "chave");

    await cliente.sendStatusImage("loja", { mimetype: "image/png", data: "QUJD" });

    const corpo = JSON.parse(String(chamadas[0]!.init.body)) as Record<string, unknown>;
    expect(corpo).not.toHaveProperty("contacts");
    expect(corpo).not.toHaveProperty("caption");
    expect(corpo.file).toEqual({ mimetype: "image/png", filename: "status", data: "QUJD" });
  });

  it("recusa do provedor vira erro com o status no nome (o chamador vê o HTTP)", async () => {
    provedorQueResponde(400, { message: "store not enabled" });
    const cliente = new WahaClient("http://waha.local", "chave");

    await expect(
      cliente.sendStatusImage("loja", { mimetype: "image/jpeg", data: "QUJD" }),
    ).rejects.toThrow(/waha_status_400/);
  });
});
