import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A BUSCA DO FEED passa pela guarda de saída do webhook (`assertSafeOutboundUrl`
 * + `assertDestinoResolvidoSeguro`) ANTES de cada requisição — inclusive a de
 * cada salto de redirecionamento, que é onde o endereço interno chega depois de
 * a primeira URL ter passado. O DNS é substituído: o que se mede aqui é a ORDEM
 * (guarda antes do `fetch`), não a resolução.
 */
vi.mock("@/lib/automation/outbound-ip", () => ({
  assertDestinoResolvidoSeguro: vi.fn(async (host: string) => {
    if (host === "interno.example") throw new Error("unsafe_url:private_ip");
  }),
}));

import { buscarFeedDaUrl } from "@/lib/catalogo/feed-remoto";

afterEach(() => vi.unstubAllGlobals());

describe("buscarFeedDaUrl — a guarda de saída", () => {
  it("endereço de metadados da nuvem é recusado sem nenhuma requisição", async () => {
    const buscar = vi.fn();
    vi.stubGlobal("fetch", buscar);

    const r = await buscarFeedDaUrl("http://169.254.169.254/latest/meta-data/");

    expect(r.ok).toBe(false);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("hostname público que resolve para dentro é recusado sem requisição", async () => {
    const buscar = vi.fn();
    vi.stubGlobal("fetch", buscar);

    const r = await buscarFeedDaUrl("https://interno.example/feed.json");

    expect(r.ok).toBe(false);
    expect(buscar).not.toHaveBeenCalled();
  });

  it("redirecionamento para endereço interno é recusado ANTES do segundo fetch", async () => {
    const buscar = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://interno.example/x" } }));
    vi.stubGlobal("fetch", buscar);

    const r = await buscarFeedDaUrl("https://revenda.example/feed.json");

    expect(r.ok).toBe(false);
    expect(buscar).toHaveBeenCalledTimes(1);
  });

  it("controle: feed público e pequeno é lido", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('[{"id":"SKU-1"}]', { status: 200 })));

    const r = await buscarFeedDaUrl("https://revenda.example/feed.json");

    expect(r).toEqual({ ok: true, texto: '[{"id":"SKU-1"}]' });
  });
});
