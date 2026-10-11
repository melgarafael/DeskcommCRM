import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditarSite, auditarSites, deveReverificar, enderecoInterno, LIMITE_TENTATIVAS, recusarSSRF, type VerificadorDeHost } from "@/lib/prospecting/site-fetch";
import { vereditoPuro } from "@/lib/prospecting/site-classify";
import { prospectEnrichmentSchema } from "@/lib/prospecting/schema";

const AGORA = "2026-10-10T12:00:00.000Z";

/** Sem rede: a guarda da casa é substituída por liberação total — o DNS real nunca é tocado nos testes. */
const VERIFICADOR_LIBERADO: VerificadorDeHost = async () => {};

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
      fakeFetch({ "*": { status: 200, body: PAGINA_BOA } }), VERIFICADOR_LIBERADO,
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
      VERIFICADOR_LIBERADO,
    );
    expect(v.classe).toBe("site-ruim");
    expect(v.problemas).toContain("sem-https");
  });

  it("404 vira site-ruim com http-404", async () => {
    const v = await auditarSite(
      "https://sumiu.test/", AGORA,
      fakeFetch({ "*": { status: 404, body: "<html></html>" } }), VERIFICADOR_LIBERADO,
    );
    expect(v.classe).toBe("site-ruim");
    expect(v.problemas).toContain("http-404");
  });

  it("redirect em loop vira site-ruim sem travar", async () => {
    const v = await auditarSite(
      "https://loop.test/", AGORA,
      fakeFetch({ "*": { status: 301, body: "", location: "https://loop.test/" } }),
      VERIFICADOR_LIBERADO,
    );
    expect(v.classe).toBe("site-ruim");
  });

  it("segundo salto para rede interna é recusado (cada salto revalidado)", async () => {
    const chamadas: string[] = [];
    const fetchConta: typeof fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      chamadas.push(url);
      const headers = new Headers();
      headers.set("location", "https://interno.test/");
      return new Response("", { status: 301, headers });
    }) as typeof fetch;
    const verificador: VerificadorDeHost = async (host) => {
      if (host === "interno.test") throw new Error("unsafe_url:private_ip");
    };
    const v = await auditarSite("https://publico.test/", AGORA, fetchConta, verificador);
    // Sem revalidar cada salto, o fetch do 2º destino aconteceria (2 chamadas)
    // e o veredito não seria recusa. Com a guarda, 1 chamada só e recusa.
    expect(chamadas).toHaveLength(1);
    expect(v.classe).toBe("fora-do-ar");
    expect(v.provisorio).toBe(false);
    expect(v.final_url).toBeNull();
  });

  it("corpo gigante é abortado no teto", async () => {
    const v = await auditarSite(
      "https://grande.test/", AGORA,
      fakeFetch({ "*": { status: 200, body: `<html><head><meta name="viewport" content="x"></head><body>${"x".repeat(300_000)}</body></html>` } }),
      VERIFICADOR_LIBERADO,
    );
    expect(v.conteudo_resumo === null || v.conteudo_resumo.length <= 1200).toBe(true);
  });

  it("corpo gigante cancela o leitor sem ler tudo (prova do teto de 200KB)", async () => {
    const PEDAÇO = "y".repeat(64 * 1024);
    const TOTAL_PEDAÇOS = 8; // 512KB bem acima do teto
    let cancelado = false;
    let bytesLidos = 0;
    const fetchStream: typeof fetch = (async () => {
      let n = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (; n < TOTAL_PEDAÇOS; n++) controller.enqueue(new TextEncoder().encode(PEDAÇO));
          controller.close();
        },
        cancel() { cancelado = true; },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    // Conta os bytes que o leitor realmente puxou, embrulhando o fetch.
    const fetchConta: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetchStream(input, init);
      const leitor = res.body!.getReader();
      const enc = new TextEncoder();
      void enc;
      const medido = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await leitor.read();
          if (done) { controller.close(); return; }
          bytesLidos += value.byteLength;
          controller.enqueue(value);
        },
        cancel(reason) { cancelado = true; return leitor.cancel(reason); },
      });
      return new Response(medido, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const v = await auditarSite("https://grande.test/", AGORA, fetchConta, VERIFICADOR_LIBERADO);
    // Sem o abort, o leitor consumiria os 512KB e ninguém chamaria cancel.
    expect(cancelado).toBe(true);
    expect(bytesLidos).toBeLessThan(TOTAL_PEDAÇOS * 64 * 1024);
    expect(bytesLidos).toBeLessThanOrEqual(300 * 1024);
    expect(v.conteudo_resumo === null || v.conteudo_resumo.length <= 1200).toBe(true);
  });

  it("construtor aparece como problema único", async () => {
    const v = await auditarSite(
      "https://loja.webnode.page/", AGORA,
      fakeFetch({ "*": { status: 200, body: '<html><head><meta name="viewport" content="x"></head><body>loja</body></html>' } }),
      VERIFICADOR_LIBERADO,
    );
    expect(v.problemas).toContain("construtor-Webnode");
  });

  it("falha de DNS vira provisório, não citável (reverifica depois)", async () => {
    const verificadorDnsMorto: VerificadorDeHost = async () => { throw new Error("unsafe_url:dns_failed"); };
    const v = await auditarSite(
      "https://dns-morto.test/", AGORA,
      fakeFetch({ "*": { status: 200, body: PAGINA_BOA } }), verificadorDnsMorto,
    );
    expect(v.classe).toBe("fora-do-ar");
    expect(v.provisorio).toBe(true);
    expect(v.tentativas).toBe(1);
  });

  it("timeout persistente vira provisório com 1 retry real", async () => {
    let chamadas = 0;
    const fetchLento: typeof fetch = (async () => {
      chamadas++;
      throw new Error("fetch failed");
    }) as typeof fetch;
    const v = await auditarSite("https://lento.test/", AGORA, fetchLento, VERIFICADOR_LIBERADO);
    expect(chamadas).toBe(2); // 1 tentativa + 1 retry de verdade
    expect(v.provisorio).toBe(true);
    expect(v.tentativas).toBe(1);
  }, 15000);

  it("provisório congela definitivo ao bater o teto de tentativas", async () => {
    const fetchRuim: typeof fetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    const v = await auditarSite(
      "https://sempre-lento.test/", AGORA, fetchRuim, VERIFICADOR_LIBERADO, LIMITE_TENTATIVAS - 1,
    );
    expect(v.provisorio).toBe(false);
    expect(v.tentativas).toBe(LIMITE_TENTATIVAS);
    expect(v.classe).toBe("fora-do-ar");
  }, 15000);

  it("deveReverificar só chama de volta o provisório abaixo do teto", () => {
    expect(deveReverificar({ provisorio: true, tentativas: 0 })).toBe(true);
    expect(deveReverificar({ provisorio: true, tentativas: LIMITE_TENTATIVAS - 1 })).toBe(true);
    expect(deveReverificar({ provisorio: true, tentativas: LIMITE_TENTATIVAS })).toBe(false);
    expect(deveReverificar({ provisorio: false, tentativas: 0 })).toBe(false);
  });

  it("DNS que resolve para rede interna é recusado (guarda da casa)", async () => {
    const verificadorInterno: VerificadorDeHost = async () => { throw new Error("unsafe_url:private_ip"); };
    const v = await auditarSite(
      "https://interno.test/", AGORA,
      fakeFetch({ "*": { status: 200, body: PAGINA_BOA } }), verificadorInterno,
    );
    expect(v.classe).toBe("fora-do-ar");
    expect(v.provisorio).toBe(false);
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
    const saidas = await auditarSites(urls, AGORA, 2, misto, VERIFICADOR_LIBERADO);
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

describe("recusarSSRF", () => {
  it("barra literal sem rede", () => {
    expect(recusarSSRF("http://127.0.0.1/")).toBe("rede-interna");
    expect(recusarSSRF("http://10.0.0.5/")).toBe("rede-interna");
    expect(recusarSSRF("http://192.168.1.1/")).toBe("rede-interna");
    expect(recusarSSRF("http://169.254.169.254/")).toBe("rede-interna");
    expect(recusarSSRF("http://localhost/")).toBe("rede-interna");
    expect(recusarSSRF("http://[::1]/")).toBe("rede-interna");
    expect(recusarSSRF("file:///etc/passwd")).toBe("protocolo-bloqueado");
    expect(recusarSSRF("https://user:pass@x.com/")).toBe("credencial-na-url");
    expect(recusarSSRF("https://clinica.com.br")).toBeNull();
    expect(recusarSSRF("not a url")).toBe("url-invalida");
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
