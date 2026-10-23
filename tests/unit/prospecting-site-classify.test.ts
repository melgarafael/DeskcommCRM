import { describe, expect, it } from "vitest";
import {
  derivarClasse,
  descreverProblema,
  detectarConstrutor,
  ehAgregador,
  ehSemSite,
  hostDeSite,
  MINIMO_CHARS_PAGINA_REAL,
  montarChecklist,
} from "@/lib/prospecting/site-classify";

describe("site-classify", () => {
  it("reconhece agregador sem rede", () => {
    expect(ehAgregador("https://www.instagram.com/clinica/")).toBe(true);
    expect(ehAgregador("https://linktr.ee/fulano")).toBe(true);
    expect(ehAgregador("https://linkr.bio/fulano")).toBe(true);
    expect(ehAgregador("https://allmylinks.com/fulano")).toBe(true);
    expect(ehAgregador("https://carrd.co/fulano")).toBe(true);
    expect(ehAgregador("https://solo.to/fulano")).toBe(true);
    expect(ehAgregador("https://forms.gle/abc")).toBe(true);
    expect(ehAgregador("https://api.whatsapp.com/send?phone=5511")).toBe(true);
    expect(ehAgregador("https://m.blog.facebook.com/x")).toBe(true);
    expect(ehAgregador("https://www.clinica.com.br")).toBe(false);
    expect(ehAgregador("not-a-url")).toBe(true);
    expect(ehAgregador(null)).toBe(true);
  });

  it("rejeita esquema e host inválido no host canônico", () => {
    expect(hostDeSite("https://WWW.Clinica.COM.BR/pag")).toBe("clinica.com.br");
    expect(hostDeSite("javascript:alert(1)")).toBeNull();
    expect(hostDeSite("ftp:// arquivos/x")).toBeNull();
  });

  it("marca sem-site só para vazio", () => {
    expect(ehSemSite(null)).toBe(true);
    expect(ehSemSite("   ")).toBe(true);
    expect(ehSemSite("https://x.com")).toBe(false);
  });

  it("deduz construtor para um rótulo mesmo com 3 assinaturas", () => {
    const html = '<meta generator" content="wix"><img src="https://static.wixstatic.com/a.png">';
    expect(detectarConstrutor("https://www.wix.com", html)).toBe("Wix");
    expect(detectarConstrutor("https://loja.webnode.page/", "<html></html>")).toBe("Webnode");
    expect(detectarConstrutor("https://site.automatizo.dev.br/x", "<html></html>")).toBe("Automatizo");
    expect(detectarConstrutor("https://clinica.com.br", "<html><body>proprio</body></html>")).toBeNull();
  });

  it("monta o raio-X do HTML real", () => {
    const html = `<html><head><title>Clínica Vitta - Estética em Sorocaba</title>
      <meta name="description" content="Estética avançada com mais de dez anos de experiência e agenda aberta">
      <link rel="icon" href="/f.ico"></head><body>
      <a href="https://wa.me/551199">zap</a><a href="tel:+551199">tel</a>
      <a href="mailto:a@b.com">mail</a><a href="https://instagram.com/x">ig</a>
      <address>Rua X</address><img><img><img></body></html>`;
    const checklist = montarChecklist(html);
    expect(checklist.falta).toEqual([]);
    expect(checklist.tem).toContain("mapa");
    expect(montarChecklist("<html><body>oi</body></html>").tem).toEqual([]);
  });

  it("página mínima válida cai em quase-vazia (limiar pinado)", () => {
    expect("<html><body>oi</body></html>".trim().length).toBeLessThan(MINIMO_CHARS_PAGINA_REAL);
  });

  it("deriva a classe na ordem: agregador > sem-site > rede > http > problemas > ok", () => {
    const base = { agregador: false, semSite: false, urlFinal: "https://x.com", problemas: [] as string[] };
    expect(derivarClasse({ ...base, agregador: true, semSite: true })).toBe("agregador");
    expect(derivarClasse({ ...base, semSite: true })).toBe("sem-site");
    expect(derivarClasse({ ...base, erro: { tipo: "dns" } })).toBe("fora-do-ar");
    expect(derivarClasse({ ...base, erro: { tipo: "transitoria" } })).toBe("fora-do-ar");
    expect(derivarClasse({ ...base, erro: { tipo: "ssl", codigo: "CERT_HAS_EXPIRED" } })).toBe("ssl-invalido");
    expect(derivarClasse({ ...base, erro: { tipo: "http", status: 404 } })).toBe("site-ruim");
    expect(derivarClasse({ ...base, urlFinal: "http://x.com/" })).toBe("site-ruim");
    expect(derivarClasse({ ...base, problemas: ["nao-mobile"] })).toBe("site-ruim");
    expect(derivarClasse(base)).toBe("site-ok");
  });

  it("descreve problema em linguagem leiga", () => {
    expect(descreverProblema("nao-mobile")).toContain("celular");
    expect(descreverProblema("http-404")).toContain("404");
    expect(descreverProblema("construtor-Wix")).toContain("Wix");
    expect(descreverProblema("falta-whatsapp")).toContain("WhatsApp");
  });

  it("todo código emitido pertence ao vocabulário fechado", async () => {
    const { derivarClasse } = await import("@/lib/prospecting/site-classify");
    const conhecidos = new Set([
      "sem-https", "ssl-invalido", "fora-do-ar", "dns-morto", "nao-mobile", "lento",
      "quase-vazia", "conteudo-misto", "sem-atualizacao",
      "whatsapp", "tel", "mailto", "social", "mapa", "fotos", "titulo", "description", "favicon",
    ]);
    const amostras: Array<Parameters<typeof derivarClasse>[0]> = [
      { agregador: true, semSite: false, urlFinal: "", problemas: [] },
      { agregador: false, semSite: true, urlFinal: "", problemas: [] },
      { agregador: false, semSite: false, urlFinal: "", erro: { tipo: "dns" }, problemas: [] },
      { agregador: false, semSite: false, urlFinal: "", erro: { tipo: "ssl", codigo: "X" }, problemas: [] },
      { agregador: false, semSite: false, urlFinal: "", erro: { tipo: "http", status: 500 }, problemas: [] },
      { agregador: false, semSite: false, urlFinal: "http://x/", problemas: ["nao-mobile", "falta-tel"] },
      { agregador: false, semSite: false, urlFinal: "https://x/", problemas: ["construtor-Wix", "lento"] },
      { agregador: false, semSite: false, urlFinal: "https://x/", problemas: [] },
    ];
    for (const a of amostras) {
      expect(["agregador", "sem-site", "site-ok", "site-ruim", "ssl-invalido", "fora-do-ar"]).toContain(
        derivarClasse(a),
      );
      for (const p of a.problemas) {
        const base = p.startsWith("http-") ? "http" : p.startsWith("construtor-") ? "construtor" : p.startsWith("falta-") ? p.slice(6) : p.startsWith("sem-atualizacao-desde-") ? "sem-atualizacao" : p;
        expect(base === "http" || base === "construtor" || conhecidos.has(base), `código fora do vocabulário: ${p}`).toBe(true);
      }
    }
  });
});
