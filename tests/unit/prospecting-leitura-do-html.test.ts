/**
 * A leitura do HTML do site da prospecção tem custo proporcional ao tamanho da
 * página, e devolve o MESMO que a leitura anterior.
 *
 * `antigo` abaixo é a cópia literal das expressões que `lib/prospecting/leitura-do-html.ts`
 * substituiu. Elas só rodam aqui sobre entrada pequena (sorteada) ou páginas
 * normais — nunca sobre as páginas grandes do bloco de tempo, onde levavam de
 * segundos a minutos (medição no commit).
 */
import { describe, expect, it } from "vitest";

import {
  conteudoDoTitulo,
  conteudosDeH1H2,
  descricaoComConteudoAntes,
  descricaoComNomeAntes,
  semBlocosDeScript,
  semTags,
  temDescricaoLonga,
  temLinkComHrefHttp,
} from "@/lib/prospecting/leitura-do-html";
import { montarChecklist, type ItemDoRaioX, type RaioXDoSite } from "@/lib/prospecting/site-classify";
import { auditarSite, textoVisivel, type VerificadorDeHost } from "@/lib/prospecting/site-fetch";

const antigo = {
  semTags: (t: string) => t.replace(/<[^>]+>/g, " "),
  semBlocos: (h: string) => h.replace(/<(script|style|noscript)[^>]*>.*?<\/\1>/gis, " "),
  titulo: (h: string) => /<title[^>]*>(.*?)<\/title>/is.exec(h)?.[1] ?? null,
  h1h2: (h: string) => [...h.matchAll(/<h[12][^>]*>(.*?)<\/h[12]>/gis)].map((m) => m[1] ?? ""),
  nomeAntes: (h: string) =>
    /<meta[^>]+name=["']description["\'][^>]+content=["'](.*?)["']/is.exec(h)?.[1] ?? null,
  conteudoAntes: (h: string) =>
    /<meta[^>]+content=["'](.*?)["\'][^>]+name=["']description["']/is.exec(h)?.[1] ?? null,
  descricaoLonga: (h: string) =>
    /<meta[^>]+name=["']description["\'][^>]+content=["'](.{30,})["']/i.test(h),
  conteudoMisto: (h: string) => /(?:\ssrc=["']http:\/\/|<link[^>]+href=["']http:\/\/)/i.test(h),
};

// ─── cópia da implementação anterior de site-fetch.ts / site-classify.ts ─────
function extrairPrimeiroAntigo(html: string, padrao: RegExp): string | null {
  const m = padrao.exec(html);
  return m?.[1] ? m[1].replace(/\s+/g, " ").trim() || null : null;
}

function montarResumoAntigo(html: string): string | null {
  const partes: string[] = [];
  const titulo = extrairPrimeiroAntigo(html, /<title[^>]*>(.*?)<\/title>/is);
  if (titulo) partes.push(`Título: ${titulo}`);
  const descricao =
    extrairPrimeiroAntigo(html, /<meta[^>]+name=["']description["\'][^>]+content=["'](.*?)["']/is) ??
    extrairPrimeiroAntigo(html, /<meta[^>]+content=["'](.*?)["\'][^>]+name=["']description["']/is);
  if (descricao) partes.push(`Descrição: ${descricao}`);
  const cabecalhos = [...html.matchAll(/<h[12][^>]*>(.*?)<\/h[12]>/gis)]
    .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  if (cabecalhos.length > 0) partes.push(`Cabeçalhos: ${cabecalhos.join(" | ")}`);
  const corpo = html
    .replace(/<(script|style|noscript)[^>]*>.*?<\/\1>/gis, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  if (corpo) partes.push(`Trecho: ${corpo}`);
  if (partes.length === 0) return null;
  return partes.join("\n").slice(0, 1200);
}

function textoVisivelAntigo(html: string): string {
  return (html || "")
    .replace(/<(script|style|noscript)[^>]*>.*?<\/\1>/gis, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TITULOS_VAZIOS = new Set(["home", "index", "início", "inicio", "untitled"]);
function montarChecklistAntigo(html: string): RaioXDoSite {
  const fonte = html || "";
  const minusculo = fonte.toLowerCase();
  const temWhatsapp = minusculo.includes("wa.me/") || minusculo.includes("api.whatsapp.com");
  const presente: Array<[ItemDoRaioX, boolean]> = [
    ["whatsapp", temWhatsapp || minusculo.includes("whatsapp")],
    ["tel", minusculo.includes('href="tel:') || minusculo.includes("href='tel:") || temWhatsapp],
    ["mailto", minusculo.includes("mailto:")],
    ["social", minusculo.includes("instagram.com") || minusculo.includes("facebook.com")],
    [
      "mapa",
      minusculo.includes("google.com/maps") ||
        minusculo.includes("maps.google") ||
        minusculo.includes("<address") ||
        /\b\d{5}-\d{3}\b/.test(fonte),
    ],
    ["fotos", (minusculo.match(/<img\b/g) ?? []).length >= 3],
    [
      "titulo",
      (() => {
        const m = /<title[^>]*>(.*?)<\/title>/is.exec(fonte);
        const texto = (m?.[1] ?? "").replace(/\s+/g, " ").trim();
        return texto.length > 0 && !TITULOS_VAZIOS.has(texto.toLowerCase());
      })(),
    ],
    [
      "description",
      /<meta[^>]+name=["']description["\'][^>]+content=["'](.{30,})["']/i.test(fonte),
    ],
    ["favicon", /rel=["'](?:shortcut )?icon/i.test(minusculo)],
  ];
  return {
    tem: presente.filter(([, ok]) => ok).map(([nome]) => nome),
    falta: presente.filter(([, ok]) => !ok).map(([nome]) => nome),
  };
}
// ─────────────────────────────────────────────────────────────────────────────

const AGORA = "2026-10-10T12:00:00.000Z";
const LIBERADO: VerificadorDeHost = async () => {};
const responde = (body: string) =>
  (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

const PAGINAS: Record<string, string> = {
  "a dos testes de auditoria": `<html><head><meta name="viewport" content="width=device-width">
<title>Clínica Vitta - Estética em Sorocaba</title>
<meta name="description" content="Estética avançada com mais de dez anos de experiência e agenda aberta todos os dias">
<link rel="icon" href="/f.ico"></head><body><h1>Bem-vindo à Vitta</h1>
<a href="https://wa.me/551199">zap</a><a href="tel:+551199">tel</a><a href="mailto:a@b.com">m</a>
<a href="https://instagram.com/x">ig</a><a href="https://google.com/maps?q=x">mapa</a>
<img src="a.jpg"><img src="b.jpg"><img src="c.jpg"><p>Texto visível da clínica com serviços e contato.</p></body></html>`,
  "script inline grande": `<!doctype html><html><head><meta charset="utf-8"><title>Padaria Trigo Bom</title>
<script>window.dataLayer=[];${"function f(a){return a<b&&c>d?'<div>':\"</span>\"}".repeat(800)}</script>
<script type="application/ld+json">{"@type":"Bakery","name":"Trigo Bom"}</script></head>
<body><h1>Pães artesanais</h1><p>Fornada às 6h e às 16h. Rua das Flores, 120 - 18040-000.</p>
<SCRIPT src="https://cdn.exemplo.com/app.js"></SCRIPT></body></html>`,
  "style e noscript": `<html><head><title>Oficina Motor Forte</title><meta name="description" content="Oficina">
<style media="all">
body{font-family:serif}.a>.b{color:red}${".x{margin:0}".repeat(500)}</style>
<link rel="stylesheet" href="http://cdn.velho.com/s.css"></head><body>
<noscript><img src="https://px.exemplo.com/p.gif"></noscript><h2 class="t">Revisão completa</h2>
<p>Troca de óleo, freio e suspensão. Atendemos frotas.</p><Style>.y{}</STYLE><p>Fim.</p></body></html>`,
  "meta em ordem trocada": `<html><head>
<meta content="Advocacia trabalhista e previdenciária em Campinas desde 1998" name="description">
<meta property="og:title" content="Silva &amp; Souza"><title>Silva &amp; Souza Advogados</title>
</head><body><h1>Seus direitos, sem rodeio</h1><p>Consulta inicial gratuita.</p></body></html>`,
  "title com atributos e meta minificada": `<html lang="pt-br"><head><title data-rh="true" id="t">
  Pet Shop Amigo Fiel
</title><meta name='description' content='Banho e tosa'><meta name="theme-color" content="#123456"><link rel="shortcut icon" href="/i.png"></head><body><h1>Banho &amp; tosa</h1><p>Copyright © 2021 Amigo Fiel</p></body></html>`,
  "h1 com spans": `<html><head><title>Home</title><meta name="DESCRIPTION" content="Imóveis para alugar e comprar na zona sul, com visita no mesmo dia"></head>
<body><h1 class="hero"><span>Seu</span> <span class="destaque">novo lar</span></h1>
<h2>Apartamentos<br>e casas</h2><H2>Contato</H2><h1></h1><h2><img src="x.png"></h2>
<h1>Um</h1><h2>Dois</h2><h1>Três</h1><h2>Quatro</h2><h1>Cinco</h1>
<address>Av. Brasil, 1000</address><a href="https://facebook.com/imob">fb</a></body></html>`,
  "descrição com > no valor": `<html><head><meta content="Serviços > Consultoria > Treinamento para pequenas empresas" name="description">
<meta property="og:description" content="Consultoria para pequenas empresas"><title>Consultoria Alfa</title></head>
<body><p>Texto</p></body></html>`,
};

describe("leitura do HTML: mesmo resultado da leitura anterior", () => {
  for (const [nome, html] of Object.entries(PAGINAS)) {
    it(`página normal (${nome}): resumo, texto visível e checklist iguais`, async () => {
      const v = await auditarSite("https://site.test/", AGORA, responde(html), LIBERADO);
      expect(v.conteudo_resumo).toBe(montarResumoAntigo(html));
      expect(textoVisivel(html)).toBe(textoVisivelAntigo(html));
      expect(montarChecklist(html)).toEqual(montarChecklistAntigo(html));
      expect(v.problemas.includes("conteudo-misto")).toBe(antigo.conteudoMisto(html));
    });
  }

  it("as páginas normais exercitam o que mudou", () => {
    const todas = Object.values(PAGINAS);
    expect(todas.filter((h) => antigo.nomeAntes(h)).length).toBeGreaterThan(1);
    expect(todas.filter((h) => !antigo.nomeAntes(h) && antigo.conteudoAntes(h)).length).toBeGreaterThan(1);
    expect(todas.some((h) => antigo.conteudoMisto(h))).toBe(true);
    expect(todas.some((h) => antigo.descricaoLonga(h))).toBe(true);
    expect(todas.some((h) => !antigo.descricaoLonga(h) && antigo.nomeAntes(h))).toBe(true);
  });

  // Entrada sorteada de pedaços de tag (semente fixa): pega toda divergência de
  // borda — aberturas aninhadas, `>` dentro do valor, quebra de linha, caixa.
  const PEDACOS = [
    "<meta", "<META", " ", "x", ">", "<", '"', "'", "\n", "<>",
    ' name="description"', " name='description'", ' NAME="Description"', "name=\"description'",
    ' content="', " content='", "content=\"", "abcdefghijklmnopqrstuvwxyz0123456789",
    "<title", "</title>", "<TITLE>", "<script", "</script>", "<style>", "</STYLE>", "<noscript", "</noscript>",
    "<h1", "<h2>", "</h1>", "</H2>", "<link", ' href="http://', " href='HTTP://",
  ];
  function sorteio(semente: number) {
    let s = semente;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }
  it("entrada sorteada: cada leitura devolve o mesmo que a expressão anterior", () => {
    const acaso = sorteio(3745);
    for (let rodada = 0; rodada < 4000; rodada++) {
      const n = 1 + Math.floor(acaso() * 24);
      let h = "";
      for (let i = 0; i < n; i++) h += PEDACOS[Math.floor(acaso() * PEDACOS.length)];
      const ctx = { rodada, h };
      expect({ ...ctx, r: semTags(h) }).toEqual({ ...ctx, r: antigo.semTags(h) });
      expect({ ...ctx, r: semBlocosDeScript(h) }).toEqual({ ...ctx, r: antigo.semBlocos(h) });
      expect({ ...ctx, r: conteudoDoTitulo(h) }).toEqual({ ...ctx, r: antigo.titulo(h) });
      expect({ ...ctx, r: conteudosDeH1H2(h) }).toEqual({ ...ctx, r: antigo.h1h2(h) });
      expect({ ...ctx, r: descricaoComNomeAntes(h) }).toEqual({ ...ctx, r: antigo.nomeAntes(h) });
      expect({ ...ctx, r: descricaoComConteudoAntes(h) }).toEqual({ ...ctx, r: antigo.conteudoAntes(h) });
      expect({ ...ctx, r: temDescricaoLonga(h) }).toEqual({ ...ctx, r: antigo.descricaoLonga(h) });
      expect({ ...ctx, r: /\ssrc=["']http:\/\//i.test(h) || temLinkComHrefHttp(h) }).toEqual({
        ...ctx,
        r: antigo.conteudoMisto(h),
      });
    }
  });
});

describe("leitura do HTML: tempo proporcional ao tamanho da página", () => {
  const TAMANHO = 200_000; // MAX_BODY_BYTES de site-fetch.ts
  const repetir = (pedaco: string) => pedaco.repeat(Math.ceil(TAMANHO / pedaco.length)).slice(0, TAMANHO);
  const FORMAS: Record<string, string> = {
    "abertura de script repetida sem fechamento": repetir("<script>"),
    "abertura de style repetida sem fechamento": repetir("<style>"),
    "abertura de noscript sem >": repetir("<noscript "),
    "abertura de script sem >": repetir("<script "),
    "sinal de menor repetido": repetir("<"),
    "tag sem >": repetir("<a "),
    "title aberto": repetir("<title>"),
    "title sem >": repetir("<title "),
    "h1 aberto": repetir("<h1>"),
    "h2 sem >": repetir("<h2 "),
    "meta com atributos repetidos": repetir('<meta name="description" '),
    "meta com conteúdo repetido": repetir('<meta content="x" '),
    "meta com nome e conteúdo repetidos": repetir('<meta name="description" content="'),
    "link sem >": repetir("<link "),
  };
  for (const [nome, html] of Object.entries(FORMAS)) {
    it(`lê página grande e malformada em tempo proporcional ao tamanho (${nome})`, async () => {
      const t0 = performance.now();
      await auditarSite("https://site.test/", AGORA, responde(html), LIBERADO);
      textoVisivel(html);
      montarChecklist(html);
      expect(performance.now() - t0).toBeLessThan(200);
    }, 5000);
  }
});
