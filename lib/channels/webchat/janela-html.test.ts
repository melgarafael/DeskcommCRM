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

/** Luminância relativa WCAG de um hex #rrggbb. Só para o teste medir o lado do texto. */
function luminancia(hex: string): number {
  const canal = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
}

function corDoTexto(html: string): string {
  const casou = /--cor-texto: (#[0-9a-fA-F]{6})/.exec(html);
  expect(casou).not.toBeNull();
  return casou![1]!;
}

describe("montarJanela: cor da configuração", () => {
  it("a cor da configuração sobrepõe a da marca", () => {
    const { html } = janela({ config: { cor: "#0b3d91" } });
    expect(html).toContain("--cor: #0b3d91");
    expect(html).not.toContain("--cor: #506d48");
  });

  it("sem cor na configuração, vale a cor da marca", () => {
    const { html } = janela({ config: {} });
    expect(html).toContain("--cor: #506d48");
    expect(html).toContain("--cor-texto: #ffffff");
  });

  it.each(["red", "#12", "#gggggg", "rgb(0,0,0)"])("cor inválida (%j) é ignorada e usa a marca", (cor) => {
    const { html } = janela({ config: { cor } as never });
    expect(html).toContain("--cor: #506d48");
    expect(html).toContain("--cor-texto: #ffffff");
  });

  it("cor clara da configuração dá texto escuro", () => {
    const { html } = janela({ config: { cor: "#ffeb3b" } });
    expect(html).toContain("--cor: #ffeb3b");
    expect(luminancia(corDoTexto(html))).toBeLessThan(0.1);
  });

  it("cor escura da configuração dá texto claro", () => {
    const { html } = janela({ config: { cor: "#0b3d91" } });
    expect(html).toContain("--cor: #0b3d91");
    expect(luminancia(corDoTexto(html))).toBeGreaterThan(0.8);
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

  it("o campo de texto é textarea, para Shift+Enter quebrar linha", () => {
    const { html } = janela();
    expect(html).toContain('<textarea id="webchat-texto"');
    expect(html).not.toMatch(/<input[^>]*id="webchat-texto"/);
    expect(html).toContain(".entrada textarea");
    expect(html).toContain("resize: none");
  });
});

/** Extrai o objeto JSON do elemento <script id="webchat-config"> do HTML. */
function dadosDaJanela(html: string): unknown {
  const casou = /<script type="application\/json" id="webchat-config">([\s\S]*?)<\/script>/.exec(
    html,
  );
  expect(casou).not.toBeNull();
  return JSON.parse(casou![1]!);
}

describe("montarJanela: dados da janela (Tarefa 10a)", () => {
  it("com tudo ausente, o JSON tem os padroes", () => {
    const dados = dadosDaJanela(janela().html) as Record<string, unknown>;
    expect(dados.avatar).toBeNull();
    expect(dados.autoAbrirSegundos).toBe(0);
    expect(dados.som).toBe(false);
    expect(dados.respostasRapidas).toEqual([]);
  });

  it("com tudo preenchido, tem os valores", () => {
    const dados = dadosDaJanela(
      janela({
        config: {
          avatar_url: "https://example.com/avatar.png",
          auto_abrir_segundos: 30,
          som: true,
          respostas_rapidas: ["Sim", "Nao"],
        },
      }).html,
    ) as Record<string, unknown>;
    expect(dados.avatar).toBe("https://example.com/avatar.png");
    expect(dados.autoAbrirSegundos).toBe(30);
    expect(dados.som).toBe(true);
    expect(dados.respostasRapidas).toEqual(["Sim", "Nao"]);
  });

  it("respostas_rapidas com </script> nao fecha a tag do config", () => {
    const { html } = janela({
      config: { respostas_rapidas: ["fim </script><img src=x onerror=alert(1)>"] },
    });
    // Duas tags de fechamento: a do config e a do script externo. Nenhuma a mais.
    expect(html.split("</script>").length - 1).toBe(2);
    expect(html).not.toContain("<img src=x");
  });

  it("valor com < dentro de respostas_rapidas sai escapado no JSON", () => {
    const dados = dadosDaJanela(
      janela({ config: { respostas_rapidas: ["texto <tag> e & mais"] } }).html,
    ) as Record<string, unknown>;
    expect(dados.respostasRapidas).toEqual(["texto <tag> e & mais"]);
  });
});
