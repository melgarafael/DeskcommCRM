import { afterEach, describe, expect, it, vi } from "vitest";

import { basePublicaDaInstalacao, basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";
import { env } from "@/lib/env";

describe("basePublicaDoWebhookMeta / META_WEBHOOK_BASE_URL (#1426)", () => {
  const req = {
    headers: new Headers({ origin: "https://origin.internal" }),
    nextUrl: new URL("https://host.internal/api/v1/channels/official"),
  };

  afterEach(() => vi.restoreAllMocks());

  it("prioriza META_WEBHOOK_BASE_URL quando configurada, normalizando barras finais", () => {
    vi.spyOn(env, "META_WEBHOOK_BASE_URL", "get").mockReturnValue("https://deskcomm.empresa.com.br///");
    vi.spyOn(env, "NEXT_PUBLIC_APP_URL", "get").mockReturnValue("https://deskcomm.empresa.internal");

    expect(basePublicaDoWebhookMeta(req)).toBe("https://deskcomm.empresa.com.br");
    // Guarda do escopo: a base da instalação também monta o webhook da Zernio e do
    // canal parceiro (`/api/v1/webhooks/channel/<token>`), e a variável da Meta não a toca.
    expect(basePublicaDaInstalacao(req)).toBe("https://deskcomm.empresa.internal");
  });

  it("recai para NEXT_PUBLIC_APP_URL quando META_WEBHOOK_BASE_URL estiver vazia", () => {
    vi.spyOn(env, "META_WEBHOOK_BASE_URL", "get").mockReturnValue("");
    vi.spyOn(env, "NEXT_PUBLIC_APP_URL", "get").mockReturnValue("https://deskcomm.empresa.internal/");

    expect(basePublicaDoWebhookMeta(req)).toBe("https://deskcomm.empresa.internal");
  });

  it("recai para origin/nextUrl quando NEXT_PUBLIC_APP_URL for placeholder.invalid e META_WEBHOOK_BASE_URL for vazia", () => {
    vi.spyOn(env, "META_WEBHOOK_BASE_URL", "get").mockReturnValue("");
    vi.spyOn(env, "NEXT_PUBLIC_APP_URL", "get").mockReturnValue("https://placeholder.invalid");

    expect(basePublicaDoWebhookMeta(req)).toBe("https://origin.internal");
  });

  it("ignora placeholder.invalid em META_WEBHOOK_BASE_URL", () => {
    vi.spyOn(env, "META_WEBHOOK_BASE_URL", "get").mockReturnValue("https://placeholder.invalid");
    vi.spyOn(env, "NEXT_PUBLIC_APP_URL", "get").mockReturnValue("https://app.real.com");

    expect(basePublicaDoWebhookMeta(req)).toBe("https://app.real.com");
  });
});
