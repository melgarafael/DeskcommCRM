import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditarSite, auditarSites, type ResolvedorDns } from "@/lib/prospecting/site-fetch";
import { enderecoInterno, vereditoPuro } from "@/lib/prospecting/site-classify";
import { prospectEnrichmentSchema } from "@/lib/prospecting/schema";

const AGORA = "2026-10-10T12:00:00.000Z";

/** Sem rede: finge DNS vazio (prossegue) — o DNS real nunca é tocado nos testes. */
const RESOLVER_FAKE: ResolvedorDns = async () => [];

const PAGINA_BOA = `<html><head><meta name="viewport" content="width=device-width">
<title>Clínica Vitta - Estética em Sorocaba</title>
<meta name="description" content="Estética avançada com mais de dez anos de experiência e agenda aberta todos os dias">
<link rel="icon" href="/f.ico"></head><body><h1>Bem-vindo à Vitta</h1>
<a href="https://wa.me/551199">zap</a><a href="tel:+551199">tel</a><a href="mailto:a@b.com">m</a>
<a href="https://instagram.com/x">ig</a><a href="https://google.com/maps?q=x">mapa</a>
<img src="a.jpg"><img src="b.jpg"><img src="c.jpg"><p>Texto visível da clínica com serviços e contato.</p><p>Atendemos de segunda a sábado com hora marcada, convênios e pacotes promocionais para novos pacientes da região.</p><ul><li>Limpeza de pele</li><li>Harmonização facial</li><li>Massagem modeladora</li><li>Avaliação gratuita</li></ul></body></html>`;

function fakeFetch(respostas: Record<string, { status: number; body: string; location?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).hostname;
    const r = respostas[host] ?? respostas["*"];
    if (!r) throw new Error(`sem resposta fake para ${host}`);
    const headers = new Headers();
    if (r.location) headers.set("location", r.location);
    return new Response(r.body, { status: r.status, headers });
  }) as typeof fetch;
}

describe("site-fetch", () => {
  it("site bom sai ok com checklist e resumo", async () => {
    const v = await auditarSite(
      "https://clinica.test/", AGORA,
      fakeFetch({ "*": { status: 200, body: PAGINA_BOA } }), RESOLVER_FAKE,
    );
    expect(v.classe).toBe("site-ok");
    expect(v.problemas).toEqual([]);
    expect(v.checklist.tem).toContain("whatsapp");
    expect(v.http_status).toBe(200);
    expect(v.conteudo_resumo).toContain("Vitta");
    expect(v.pagespeed).toBeNull();
    expect(v.verificado_em).toBe(AGORA);
  });

  it("http final vira sem-https e site-ruim", async () => {
    const v = await auditarSite(
      "http://a.test/", AGORA,
      fakeFetch({
        "a.test": { status: 301, body: "", location: "http://b.test/" },
        "b.test": { status: 200, body: PAGINA_BOA },
      }),
      RESOLVER_FAKE,
    );
    expect(v.classe).toBe("site-ruim");
    expect(v.problemas).toContain("sem-https");
  });

  it("404 vira site-ruim com http-404", async () => {
    const v = await auditarSite(
      "https://sumiu.test/", AGORA,
      fakeFetch({ "*": { status: 404, body: "<html></html>" } }), RESOLVER_FAKE,
    );
    expect(v.classe).toBe("site-ruim");
    expect(v.problemas).toContain("http-404");
  });

  it("redirect em loop vira site-ruim sem travar", async () => {
    const v = await auditarSite(
      "https://loop.test/", AGORA,
      fakeFetch({ "*": { status: 301, body: "", location: "https://loop.test/" } }),
      RESOLVER_FAKE,
    );
    expect(v.classe).toBe("site-ruim");
  });

  it("corpo gigante é abortado no teto", async () => {
    const v = await auditarSite(
      "https://grande.test/", AGORA,
      fakeFetch({ "*": { status: 200, body: `<html><head><meta name="viewport" content="x"></head><body>${"x".repeat(300_000)}</body></html>` } }),
      RESOLVER_FAKE,
    );
    expect(v.conteudo_resumo === null || v.conteudo_resumo.length <= 1200).toBe(true);
  });

  it("construtor aparece como problema único", async () => {
    const v = await auditarSite(
      "https://loja.webnode.page/", AGORA,
      fakeFetch({ "*": { status: 200, body: '<html><head><meta name="viewport" content="x"></head><body>loja</body></html>' } }),
      RESOLVER_FAKE,
    );
    expect(v.problemas).toContain("construtor-Webnode");
  });

  it("DNS que resolve para rede interna é recusado", async () => {
    const resolverInterno: ResolvedorDns = async () => [{ address: "10.9.9.9" }];
    const v = await auditarSite(
      "https://interno.test/", AGORA,
      fakeFetch({ "*": { status: 200, body: PAGINA_BOA } }), resolverInterno,
    );
    expect(v.classe).toBe("fora-do-ar");
    expect(v.final_url).toBeNull();
  });

  it("lote nunca rejeita e preserva ordem", async () => {
    const ruim: typeof fetch = (() => {
      throw new Error("queda");
    }) as unknown as typeof fetch;
    const misto: typeof fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("ruim")) return ruim(url);
      return new Response(PAGINA_BOA, { status: 200 });
    }) as typeof fetch;
    const urls = ["https://a.test/", "https://ruim.test/", "https://b.test/"];
    const saidas = await auditarSites(urls, AGORA, 2, misto, RESOLVER_FAKE);
    expect(saidas.map((s) => s.classe)).toEqual(["site-ok", "fora-do-ar", "site-ok"]);
  });

  describe("SSRF contra servidor local real", () => {
    let server: Server;
    let porta = 0;
    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGINA_BOA);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      porta = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    });

    it("recusa 127.0.0.1 mesmo com 200 atrás", async () => {
      const v = await auditarSite(`http://127.0.0.1:${porta}/`, AGORA);
      expect(v.classe).toBe("fora-do-ar");
      expect(v.final_url).toBeNull();
    }, 15000);
  });
});

describe("enderecoInterno", () => {
  it("recusa internos e libera públicos", () => {
    expect(enderecoInterno("10.0.0.1")).toBe(true);
    expect(enderecoInterno("172.16.5.4")).toBe(true);
    expect(enderecoInterno("192.168.0.1")).toBe(true);
    expect(enderecoInterno("127.0.0.1")).toBe(true);
    expect(enderecoInterno("169.254.169.254")).toBe(true);
    expect(enderecoInterno("::1")).toBe(true);
    expect(enderecoInterno("fc00::1")).toBe(true);
    expect(enderecoInterno("fe80::1")).toBe(true);
    expect(enderecoInterno("::ffff:10.1.2.3")).toBe(true);
    expect(enderecoInterno("8.8.8.8")).toBe(false);
    expect(enderecoInterno("::ffff:8.8.8.8")).toBe(false);
    expect(enderecoInterno("invalido")).toBe(false);
  });
});

describe("vereditoPuro", () => {
  it("resolve agregador e sem-site sem rede", () => {
    expect(vereditoPuro("https://instagram.com/x", AGORA)?.classe).toBe("agregador");
    expect(vereditoPuro(null, AGORA)?.classe).toBe("sem-site");
    expect(vereditoPuro("   ", AGORA)?.classe).toBe("sem-site");
    expect(vereditoPuro("https://clinica.com.br", AGORA)).toBeNull();
  });
});

describe("prospectEnrichmentSchema com site", () => {
  it("aceita e preserva o sub-schema opcional", () => {
    const parsed = prospectEnrichmentSchema.safeParse({
      name: "X", category: null, address: null, website: "https://x.com", maps_url: null,
      rating: 5, reviews: 10, emails: [], socials: [],
      site: {
        ver: 1, classe: "site-ok", problemas: [], checklist: { tem: ["tel"], falta: [] },
        final_url: "https://x.com/", http_status: 200, tempo_ms: 300,
        conteudo_resumo: null, pagespeed: null, verificado_em: AGORA,
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.site?.classe).toBe("site-ok");
  });

  it("rejeita classe fora do vocabulário", () => {
    const parsed = prospectEnrichmentSchema.safeParse({
      name: "X", category: null, address: null, website: null, maps_url: null,
      rating: null, reviews: null, emails: [], socials: [],
      site: { ver: 1, classe: "site-lindo", problemas: [] },
    });
    expect(parsed.success).toBe(false);
  });
});
