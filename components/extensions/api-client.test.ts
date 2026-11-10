import { afterEach, describe, expect, it, vi } from "vitest";

import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

import { requestExtensionApi } from "./api-client";

vi.mock("@/lib/auth/ir-ao-desafio-de-mfa", () => ({ irAoDesafioDeMfa: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(irAoDesafioDeMfa).mockReset();
});

const resposta = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: "x" } }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("recusa por falta do código", () => {
  it("403 mfa_required leva ao desafio do código e devolve a recusa", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(403, "mfa_required")));

    const result = await requestExtensionApi("/api/v1/extensions/install", { method: "POST" });

    expect(irAoDesafioDeMfa).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: 403, error: { code: "mfa_required" } });
  });

  it("CONTROLE: 403 forbidden não leva ao desafio", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resposta(403, "forbidden")));

    await requestExtensionApi("/api/v1/extensions/install", { method: "POST" });

    expect(irAoDesafioDeMfa).not.toHaveBeenCalled();
  });
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
