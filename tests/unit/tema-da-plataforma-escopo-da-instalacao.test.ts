import { describe, expect, it } from "vitest";

import {
  cssDaExtensaoDeTema,
  ESCOPO_DA_INSTALACAO,
  ESCOPO_DO_TEMA_DA_ORGANIZACAO,
  semAsChavesDaCorDeAcao,
  type TemaDeExtensao,
} from "@/lib/extensions/tema";

/**
 * O TEMA DA PLATAFORMA (#3790) — o construtor de CSS no escopo da INSTALAÇÃO.
 *
 * ── O defeito que este arquivo mede ────────────────────────────────────────
 *
 * Até aqui o tema de extensão só existia dentro do `/app` de uma organização
 * que o escolheu: o marcador `[data-tema-extensao]` nasce em
 * `app/app/layout.tsx` e o CSS é escopado por `body:has([data-tema-extensao])`.
 * Login, `/admin` inteiro e organizações sem tema ficavam na paleta de fábrica
 * — medido numa 1.96.0: bordas `#e7e3da`, campos `#faf9f6`, texto em cinza
 * quente dentro do `/admin`.
 *
 * A correção tem duas metades, e as duas são medidas AQUI, no texto que sai:
 *
 *   1. ESCOPO: o bloco da instalação declara em `:root:root` (e no escuro em
 *      `:root:root[data-theme="dark"]`), nunca no escopo da organização. Se o
 *      seletor da empresa aparecesse neste CSS, o tema da plataforma voltaria a
 *      depender do marcador de uma organização — que é o defeito de origem.
 *   2. DONO DA COR: as chaves `--color-accent*` são DESCARTADAS. A cor de ação
 *      da instalação vem da tela Marca (`platform_branding`), com a resolução
 *      de contraste dela; duas fontes para o mesmo token fariam a cor depender
 *      de qual escolha foi feita por último.
 *
 * ── SABOTAGEM (escrita antes da execução) ──────────────────────────────────
 *
 *  - S1: trocar `ESCOPO_DA_INSTALACAO` por `ESCOPO_DO_TEMA_DA_ORGANIZACAO` ⇒
 *    "o bloco da instalação NÃO usa o seletor da organização" REPROVA.
 *  - S2: fazer `semAsChavesDaCorDeAcao` devolver o tema inteiro ⇒ "nenhuma
 *    chave --color-accent sobrevive" REPROVA.
 *  - S3: usar `tema` cru no lugar de `semAsChavesDaCorDeAcao(tema)` ⇒ o mesmo
 *    caso de S2 reprova, provando que a filtragem é o que segura a cor de ação.
 */

const temaComAccent: TemaDeExtensao = {
  palette: "mist",
  claro: {
    "--color-bg": "#f6f6f4",
    "--color-border": "#e7e3da",
    "--color-text": "#1d1c19",
    "--color-accent": "var(--color-accent-600)",
    "--color-accent-600": "#33475b",
    "--color-accent-soft": "var(--color-accent-100)",
  },
  escuro: {
    "--color-bg": "#11151c",
    "--color-border": "#2a2f38",
    "--color-text": "#ececec",
    "--color-accent": "var(--color-accent-400)",
    "--color-accent-400": "#8fa8be",
    "--color-accent-soft": "var(--color-accent-900)",
  },
};

const cssDaPlataforma = (tema: TemaDeExtensao | null) =>
  cssDaExtensaoDeTema(semAsChavesDaCorDeAcao(tema), ESCOPO_DA_INSTALACAO);

describe("tema da plataforma — o CSS sai no escopo da instalação", () => {
  it("declara em `:root:root`, no claro e no escuro", () => {
    const { css, motivos } = cssDaPlataforma(temaComAccent);

    expect(motivos).toEqual([]);
    expect(css).not.toBeNull();
    expect(css).toContain(":root:root {");
    expect(css).toContain(':root:root[data-theme="dark"] {');
  });

  it("NÃO usa o seletor da organização — nem o marcador `[data-tema-extensao]`", () => {
    const { css } = cssDaPlataforma(temaComAccent);

    expect(css).not.toBeNull();
    expect(css).not.toContain("body:has");
    expect(css).not.toContain("[data-tema-extensao]");
    for (const [seletor] of ESCOPO_DO_TEMA_DA_ORGANIZACAO) {
      expect(css).not.toContain(seletor);
    }
  });

  it("nenhuma chave `--color-accent*` sobrevive — a cor de ação é da tela Marca", () => {
    const { css } = cssDaPlataforma(temaComAccent);

    expect(css).not.toBeNull();
    expect(css).not.toContain("--color-accent");
    // As outras chaves continuam lá: o que se descarta é a COR, não o tema.
    expect(css).toContain("--color-bg: #f6f6f4");
    expect(css).toContain("--color-border: #e7e3da");
    expect(css).toContain("--color-text: #1d1c19");
    expect(css).toContain("--color-bg: #11151c");
    expect(css).toContain("--color-border: #2a2f38");
  });

  it("um tema que só declarava accent não emite bloco nenhum", () => {
    const soAccent: TemaDeExtensao = {
      palette: "olive",
      claro: { "--color-accent": "var(--color-accent-600)" },
      escuro: { "--color-accent": "var(--color-accent-400)" },
    };

    expect(cssDaPlataforma(soAccent)).toEqual({ css: null, motivos: [] });
  });

  it("sem escolha (null), nada é emitido — o caso comum não muda", () => {
    expect(cssDaPlataforma(null)).toEqual({ css: null, motivos: [] });
  });
});

describe("tema da plataforma — o escopo da organização continua intacto (#1095)", () => {
  it("o construtor sem escopo explícito ainda pinta pelo marcador da organização", () => {
    const { css } = cssDaExtensaoDeTema(temaComAccent);

    expect(css).not.toBeNull();
    expect(css).toContain("body:has([data-tema-extensao])");
    expect(css).toContain('[data-theme="dark"] body:has([data-tema-extensao])');
    // E o tema da ORGANIZAÇÃO mantém as chaves de accent: lá a cor de ação é
    // do tema, e a tela da empresa não tem tela Marca própria com precedência.
    expect(css).toContain("--color-accent-600: #33475b");
  });

  it("`semAsChavesDaCorDeAcao(null)` é null — o atalho da condição do dono", () => {
    expect(semAsChavesDaCorDeAcao(null)).toBeNull();
  });
});
