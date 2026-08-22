import { afterEach, describe, expect, it, vi } from "vitest";

import { createPayment, getPayment, PaySuiteApiError, PAYSUITE_API_BASE } from "./client";

describe("createPayment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chama POST /payments com Bearer e devolve id/checkoutUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "success", data: { id: "abc123", checkout_url: "https://pay.example/x" } }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createPayment("tok_123", { amount: "100.50", reference: "REF1" });

    expect(result).toEqual({ id: "abc123", checkoutUrl: "https://pay.example/x" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PAYSUITE_API_BASE}/payments`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_123");
    expect(JSON.parse(init.body as string)).toEqual({ amount: "100.50", reference: "REF1" });
  });

  it("lança PaySuiteApiError em resposta não-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("token inválido", { status: 401 })),
    );

    await expect(createPayment("tok_ruim", { amount: "10", reference: "R" })).rejects.toBeInstanceOf(
      PaySuiteApiError,
    );
  });

  it("lança PaySuiteApiError quando a resposta 2xx não tem id/checkout_url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "success", data: {} }), { status: 201 })),
    );

    await expect(createPayment("tok", { amount: "10", reference: "R" })).rejects.toThrow(
      /sem id\/checkout_url/,
    );
  });
});

describe("getPayment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("consulta GET /payments/{id} e devolve os dados", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: { id: "abc123", status: "paid", amount: 100.5, reference: "REF1" } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPayment("tok", "abc123");

    expect(result.status).toBe("paid");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${PAYSUITE_API_BASE}/payments/abc123`);
  });
});
