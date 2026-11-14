/**
 * A RÉGUA DOS LINKS NO TEXTO (#4576) — medida no módulo puro.
 *
 * Os casos de tela (`MessageBubble.links.test.tsx`, `NoteCard.links.test.tsx`)
 * provam o que a pessoa vê; este arquivo prova as decisões que a tela herda e
 * que são caras de errar: o que NÃO pode virar link e o que o conserto não
 * pode reformatar.
 *
 *   1. `https://…` no meio da frase          → link, texto em volta intacto;
 *   2. `www.…` sem protocolo                 → link com `https://`;
 *   3. `javascript:` (e `data:`, `file:`)    → texto, nunca link;
 *   4. texto sem endereço                    → um único pedaço, byte a byte;
 *   5. armadilhas de borda: pontuação final, parêntese balanceado, e-mail,
 *      arquivo com extensão, endereço colado a palavra.
 */
import { describe, expect, it } from "vitest";

import { hrefDoEndereco, partesComLinks } from "./links-no-texto";

/** Concatenação dos pedaços = o texto original, sempre. */
function reconstroi(partes: ReturnType<typeof partesComLinks>): string {
  return partes.map((p) => p.texto).join("");
}

describe("partesComLinks", () => {
  it("1. https no meio da frase vira link e preserva o texto em volta", () => {
    const texto = "Segue o orçamento: https://www.domtravel.com.br/orcamento?viagem=recife Amanhã.";
    const partes = partesComLinks(texto);

    expect(partes).toEqual([
      { texto: "Segue o orçamento: " },
      {
        texto: "https://www.domtravel.com.br/orcamento?viagem=recife",
        href: "https://www.domtravel.com.br/orcamento?viagem=recife",
      },
      { texto: " Amanhã." },
    ]);
    expect(reconstroi(partes)).toBe(texto);
  });

  it("2. www. sem protocolo vira link para https", () => {
    const partes = partesComLinks("O site é www.domtravel.com.br hoje");
    expect(partes[1]).toEqual({
      texto: "www.domtravel.com.br",
      href: "https://www.domtravel.com.br",
    });
    expect(reconstroi(partes)).toBe("O site é www.domtravel.com.br hoje");
  });

  it("3. javascript: NÃO vira link — nem com caminho, nem sozinho", () => {
    for (const texto of [
      "clique javascript:alert(1) agora",
      "javascript:alert(document.cookie)",
      "data:text/html,<b>oi</b>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
    ]) {
      const partes = partesComLinks(texto);
      expect(partes.every((p) => p.href === undefined)).toBe(true);
      expect(reconstroi(partes)).toBe(texto);
    }
    expect(hrefDoEndereco("javascript:alert(1)")).toBeNull();
    expect(hrefDoEndereco("data:text/html,oi")).toBeNull();
  });

  it("4. texto sem endereço é um pedaço só, sem reescrita", () => {
    const texto = "Bom dia,\n  volto às 14h.\n\nObrigado!";
    expect(partesComLinks(texto)).toEqual([{ texto }]);
  });

  it("5a. pontuação da frase fica fora do link", () => {
    const partes = partesComLinks("Veja https://x.com/a, depois (https://y.com/b).");
    expect(partes.filter((p) => p.href).map((p) => p.texto)).toEqual([
      "https://x.com/a",
      "https://y.com/b",
    ]);
    expect(reconstroi(partes)).toBe("Veja https://x.com/a, depois (https://y.com/b).");
  });

  it("5b. parêntese aberto dentro do endereço é mantido", () => {
    const url = "https://pt.wikipedia.org/wiki/Foo_(bar)";
    expect(partesComLinks(url)).toEqual([{ texto: url, href: url }]);
  });

  it("5c. e-mail, arquivo com extensão e endereço colado a palavra são texto", () => {
    for (const texto of [
      "manda para contato@empresa.com.br",
      "o anexo contrato.pdf está na pasta",
      "versão v1.2.3 publicada",
      "xhttps://x.com/a",
    ]) {
      expect(partesComLinks(texto).every((p) => p.href === undefined)).toBe(true);
    }
  });

  it("5d. domínio solto conhecido ganha link; o href nunca muda o texto", () => {
    const partes = partesComLinks("painel em loja.exemplo.com.br/pedido");
    expect(partes[1]).toEqual({
      texto: "loja.exemplo.com.br/pedido",
      href: "https://loja.exemplo.com.br/pedido",
    });
  });

  it("5e. http:// é aceito como está (o conserto não troca o esquema escrito)", () => {
    expect(partesComLinks("http://intranet.local/x")).toEqual([
      { texto: "http://intranet.local/x", href: "http://intranet.local/x" },
    ]);
  });
});
