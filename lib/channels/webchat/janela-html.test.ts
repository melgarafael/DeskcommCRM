/**
 * `montarJanela` é pura: HTML e CSP saem daqui. Testa o que a janela pública não pode errar:
 * quem pode embutir (frame-ancestors), escape de todo texto do banco e o JSON que não fecha
 * a tag de script.
 */
import { describe, expect, it, vi } from "vitest";

import type { MarcaDeSaida } from "@/lib/branding/saida";

import { montarJanela } from "./janela-html";

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.example.com" } }));
vi.mock("@/lib/webhooks/url-publica", () => ({ enderecoDaPropriaMaquina: () => false }));

const MARCA: MarcaDeSaida = {
  nome: "Loja Exemplo",
  logoUrl: null,
  accent: "#506d48",
  accentFg: "#ffffff",
  origens: { nome: "padrao", cor: "padrao" },
};

const CHAVE = `wck_${"A".repeat(43)}`;

function janela(
  sobrescrito: Partial<Parameters<typeof montarJanela>[0]> = {},
): { html: string; csp: string } {
  return montarJanela({
    chave: CHAVE,
    marca: MARCA,
    config: {},
    controlador: { razaoSocial: "Loja Exemplo Ltda", politicaUrl: null },
    origens: [],
    ...sobrescrito,
  });
}

/** O valor de `frame-ancestors` da política, sem o `;` final. */
function ancestrais(csp: string): string {
  const diretiva = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-ancestors"));
  return diretiva ?? "";
}

describe("montarJanela: frame-ancestors", () => {
  it("lista vazia de origens dá 'none': ninguém embute a janela", () => {
    expect(ancestrais(janela().csp)).toBe("frame-ancestors 'none'");
  });

  it("dois domínios entram os dois, separados por espaço, e mais nada", () => {
    const { csp } = janela({ origens: ["https://a.example.com", "https://b.example.com:8443"] });
    expect(ancestrais(csp)).toBe("frame-ancestors https://a.example.com https://b.example.com:8443");
  });

  it("item malicioso com ';' e espaço é descartado, sem injetar diretiva", () => {
    const { csp } = janela({ origens: ["https://a.com; script-src *", "https://b.example.com"] });
    expect(csp).not.toContain("script-src *");
    expect(ancestrais(csp)).toBe("frame-ancestors https://b.example.com");
  });

  it("só origens com forma de origem: caminho, http comum e lixo caem fora", () => {
    const { csp } = janela({
      origens: ["https://a.example.com/caminho", "http://a.example.com", "javascript:alert(1)", "http://localhost:3000"],
    });
    expect(ancestrais(csp)).toBe("frame-ancestors http://localhost:3000");
  });

  it("lista só com itens inválidos volta a 'none'", () => {
    expect(ancestrais(janela({ origens: ["https://a.com; x"] }).csp)).toBe("frame-ancestors 'none'");
  });
});

describe("montarJanela: política de conteúdo", () => {
  it("traz base-uri, object-src, form-action e default-src travados", () => {
    const { csp } = janela();
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
  });
});

describe("montarJanela: HTML", () => {
  it("título com <script> sai escapado, e a tag crua não aparece", () => {
    const { html } = janela({ config: { titulo: "<script>alert(1)</script>" } });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("sem título na configuração, a aba leva o nome da marca, nunca o do produto", () => {
    const { html } = janela({ config: {} });
    expect(html).toContain("<title>Loja Exemplo</title>");
  });

  it("JSON da configuração com </script> não fecha a tag do config", () => {
    const { html } = janela({ config: { saudacao: "fim </script><img src=x onerror=alert(1)>" } });
    // Duas tags de fechamento: a do config e a do script externo. Nenhuma a mais.
    expect(html.split("</script>").length - 1).toBe(2);
    expect(html).not.toContain("<img src=x");
  });

  it("o config vai dentro de application/json com id webchat-config", () => {
    const { html } = janela({ chave: CHAVE, config: { titulo: "Oi" } });
    expect(html).toContain('<script type="application/json" id="webchat-config">');
    expect(html).toContain(CHAVE);
  });

  it("cor da marca vai em variáveis CSS --cor e --cor-texto", () => {
    const { html } = janela();
    expect(html).toContain("--cor: #506d48");
    expect(html).toContain("--cor-texto: #ffffff");
  });

  it("referencia o script da janela", () => {
    expect(janela().html).toContain('<script src="/webchat-janela.js" defer></script>');
  });

  it("política nula: aviso sem link", () => {
    const { html } = janela({ controlador: { razaoSocial: "Loja", politicaUrl: null } });
    expect(html).toContain("Loja");
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toMatch(/<a [^>]*href=/);
  });

  it("política com URL: link com target e rel seguros", () => {
    const { html } = janela({
      controlador: { razaoSocial: "Loja", politicaUrl: "https://loja.example.com/privacidade" },
    });
    expect(html).toContain(
      '<a href="https://loja.example.com/privacidade" target="_blank" rel="noopener noreferrer">',
    );
  });

  it("nome da organização com HTML é escapado no aviso", () => {
    const { html } = janela({ controlador: { razaoSocial: '"><img src=x>', politicaUrl: null } });
    expect(html).not.toContain("<img src=x>");
  });

  it("tem área de mensagens vazia e campo de texto no rodapé", () => {
    const { html } = janela();
    expect(html).toContain('id="webchat-mensagens"');
    expect(html).toContain('id="webchat-texto"');
  });
});
