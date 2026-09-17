import { afterEach, describe, expect, it, vi } from "vitest";

import { requestExtensionApi } from "./api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestExtensionApi", () => {
  it("marca resposta malformada de mutação como incerta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("indisponível", { status: 502 })),
    );

    const result = await requestExtensionApi("/api/v1/extensions/install", { method: "POST" });

    expect(result).toMatchObject({ ok: false, status: 502, uncertain: true });
  });

  it("mantém recibo quando a mutação recebe erro 5xx estruturado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "upstream_unavailable",
              message: "Não foi possível confirmar o resultado.",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await requestExtensionApi("/api/v1/extensions/install", { method: "POST" });

    expect(result).toMatchObject({ ok: false, status: 503, uncertain: true });
  });

  it("trata rejeição 4xx estruturada como resultado definitivo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "validation_failed", message: "Confira os dados do pedido." },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await requestExtensionApi("/api/v1/extensions/catalogs", { method: "POST" });

    expect(result).toMatchObject({ ok: false, status: 422, uncertain: false });
  });
});
