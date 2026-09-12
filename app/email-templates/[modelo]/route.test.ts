import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { marcaDaSaida } from "@/lib/branding/saida";

/**
 * A rota que o GoTrue busca. Três coisas não podem regredir: ela só conhece os
 * dois modelos, devolve HTML de verdade, e nunca derruba o envio do e-mail por
 * causa de marca — `marcaDaSaida` degrada, e a rota confia nisso.
 */

vi.mock("@/lib/branding/saida", async () => {
  const real = await vi.importActual<typeof import("@/lib/branding/saida")>(
    "@/lib/branding/saida",
  );
  return { ...real, marcaDaSaida: vi.fn() };
});

const MARCA = {
  nome: "Acme",
  logoUrl: null,
  accent: "#506d48",
  accentFg: "#ffffff",
  origens: { nome: "instalacao", cor: "instalacao" },
};

const chamar = (modelo: string) =>
  import("./route").then(({ GET }) =>
    GET(new NextRequest(`https://exemplo.test/email-templates/${modelo}`), {
      params: Promise.resolve({ modelo }),
    }),
  );

describe("GET /email-templates/[modelo]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(marcaDaSaida).mockResolvedValue(MARCA);
  });

  it("serve o molde de confirmação com o link que fecha a sessão", async () => {
    const res = await chamar("confirmation");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const corpo = await res.text();
    expect(corpo).toContain("{{ .RedirectTo }}&token_hash={{ .TokenHash }}");
    expect(corpo).toContain("Acme");
  });

  it("serve o molde de recuperação", async () => {
    const res = await chamar("recovery");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("{{ .TokenHash }}");
  });

  it("modelo desconhecido é 404, não um HTML qualquer", async () => {
    // Sem isto, um typo na variável do GoTrue devolveria 200 com corpo errado —
    // e o cliente receberia isso por e-mail em vez de nada.
    const res = await chamar("../../etc/passwd");
    expect(res.status).toBe(404);
    expect(vi.mocked(marcaDaSaida)).not.toHaveBeenCalled();
  });

  it("resolve a marca da INSTALAÇÃO — não há organização neste momento", async () => {
    await chamar("confirmation");
    expect(vi.mocked(marcaDaSaida)).toHaveBeenCalledWith(null);
  });

  it("pede cache curto — a troca de marca tem de chegar", async () => {
    const res = await chamar("confirmation");
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });
});
