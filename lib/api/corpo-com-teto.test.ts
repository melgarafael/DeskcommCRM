// @vitest-environment node
import { describe, expect, it } from "vitest";

import { lerCorpoComTeto } from "./corpo-com-teto";

const URL_ = "http://localhost/api/v1/qualquer";

/** Corpo em partes: o que um envio chunked entrega, sem tamanho conhecido. */
function emPartes(...partes: string[]): ReadableStream<Uint8Array> {
  const codificador = new TextEncoder();
  return new ReadableStream({
    start(controle) {
      for (const parte of partes) controle.enqueue(codificador.encode(parte));
      controle.close();
    },
  });
}

function pedido(corpo: BodyInit | null, headers: Record<string, string>): Request {
  return new Request(URL_, {
    method: "POST",
    body: corpo,
    headers,
    // Exigido pelo undici para corpo em stream.
    ...(corpo instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function codigo(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("lerCorpoComTeto", () => {
  it("sem content-length e corpo pequeno → aceita (envio em partes, HTTP/2)", async () => {
    const r = await lerCorpoComTeto(pedido(emPartes("o", "i"), {}), 100, { requestId: "r" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await r.corpo.text()).toBe("oi");
  });

  it("sem content-length e corpo acima do teto → 413 pela contagem", async () => {
    const r = await lerCorpoComTeto(
      pedido(emPartes("a".repeat(60), "b".repeat(60)), {}),
      100,
      { requestId: "r" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(413);
    expect(await codigo(r.response)).toBe("payload_too_large");
  });

  it.each(["abc", "-1", "1.5", "1e3", ""])("content-length inválido (%j) → 400", async (valor) => {
    const r = await lerCorpoComTeto(pedido("x", { "content-length": valor }), 100, {
      requestId: "r",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(400);
    expect(await codigo(r.response)).toBe("invalid_request");
  });

  it("declarado acima do teto → 413 sem ler o corpo", async () => {
    let lido = false;
    // highWaterMark 0: o stream só puxa quando alguém lê.
    const corpo = new ReadableStream<Uint8Array>(
      {
        pull() {
          lido = true;
        },
      },
      { highWaterMark: 0 },
    );
    const r = await lerCorpoComTeto(pedido(corpo, { "content-length": "101" }), 100, {
      requestId: "r",
      acimaDoTeto: "Grande demais.",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(413);
    const body = (await r.response.json()) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "payload_too_large", message: "Grande demais." });
    expect(lido).toBe(false);
  });

  it("no limite exato → passa, e o texto chega inteiro", async () => {
    const texto = "a".repeat(100);
    const r = await lerCorpoComTeto(pedido(texto, { "content-length": "100" }), 100, {
      requestId: "r",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await r.corpo.text()).toBe(texto);
  });

  it("stream maior que o declarado → 413, mesmo abaixo do teto", async () => {
    const r = await lerCorpoComTeto(
      pedido(emPartes("aaaa", "bbbb", "cccc"), { "content-length": "5" }),
      100,
      { requestId: "r", codigo: "codigo_da_rota" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(413);
    expect(await codigo(r.response)).toBe("codigo_da_rota");
  });

  it("multipart lido devolve o formData com o arquivo", async () => {
    const form = new FormData();
    form.append("file", new File(["conteudo"], "a.txt", { type: "text/plain" }));
    form.append("campo", "valor");
    const serializado = new Response(form);
    const bytes = new Uint8Array(await serializado.arrayBuffer());
    const r = await lerCorpoComTeto(
      pedido(bytes, {
        "content-type": serializado.headers.get("content-type") ?? "",
        "content-length": String(bytes.byteLength),
      }),
      10_000,
      { requestId: "r" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lido = await r.corpo.formData();
    expect(lido.get("campo")).toBe("valor");
    const arquivo = lido.get("file");
    expect(arquivo).toBeInstanceOf(File);
    expect(await (arquivo as File).text()).toBe("conteudo");
  });

  it("a recusa sai no idioma de quem envia", async () => {
    const r = await lerCorpoComTeto(pedido("x", { "content-length": "abc" }), 100, {
      requestId: "r",
      idioma: "es",
    });
    if (r.ok) throw new Error("devia recusar");
    const body = (await r.response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("El tamaño declarado del envío no es válido.");
  });
});
