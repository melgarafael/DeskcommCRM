import { describe, expect, it } from "vitest";

import { checkCompatibility } from "@/lib/extensions/manifest";
import {
  CHAVES_DE_TOKEN_DO_TEMA,
  cssDaExtensaoDeTema,
  ESCOPO_DO_TEMA_DA_ORGANIZACAO,
  esquemaDaContribuicaoDeTema,
  linhaBrutaDeTema,
  temaAplicavel,
  type TemaDeExtensao,
} from "@/lib/extensions/tema";

/**
 * O GANCHO de tema (issue #1095) nasce com a condição do DONO:
 *
 *   > uma extensão declarativa v1 pode contribuir um TEMA (tokens de cor) sem
 *   > quebrar nenhuma tela de quem NÃO escolheu o tema.
 *
 * Ela é medida aqui em duas pontas:
 *
 *  1. QUEM NÃO ESCOLHEU não muda NADA — `cssDaExtensaoDeTema(null)` devolve
 *     `{ css: null }` (o estado default é o comportamento atual idêntico), o
 *     `temaAplicavel` devolve `null` sem candidato e o escopo que emite NÃO
 *     casa sem o marcador `[data-tema-extensao]`.
 *  2. QUEM ESCOLHEU recebe os tokens — o mesmo `cssDaExtensaoDeTema(tema)`
 *     devolve um bloco escopado por `[data-tema-extensao]` com as chaves.
 *
 * SABOTAGEM medida (N/M = 2/2, escrita antes da execução):
 *  - S1: apagar o atalho `if (tema === null) return { css: null, motivos }` de
 *    `cssDaExtensaoDeTema` ⇒ o teste "não escolheu ⇒ css null" deve REPROVAR.
 *  - S2: remover `[data-tema-extensao]` de `ESCOPO_DO_TEMA_DA_ORGANIZACAO` ⇒ o
 *    teste "o bloco é escopado pelo marcador" deve REPROVAR (se o bloco não for
 *    escopado, quem não tem o marcador continuaria pintado — a fuga da régua).
 */

const temaMinimo: TemaDeExtensao = {
  palette: "mist",
  claro: { "--color-bg": "#f6f6f4", "--color-accent-600": "#33475b" },
  escuro: { "--color-bg": "#11151c", "--color-accent-400": "#8fa8be" },
};

const todasAsChaves = Object.fromEntries(
    CHAVES_DE_TOKEN_DO_TEMA.map((chave) => [
      chave,
      chave.startsWith("--color-accent-") && chave !== "--color-accent-soft"
        ? "#5a6130"
        : chave === "--color-accent"
          ? "var(--color-accent-600)"
          : chave === "--color-accent-fg"
            ? "#ffffff"
            : chave === "--color-accent-soft"
              ? "var(--color-accent-100)"
              : "#f5f5ef",
    ]),
) as TemaDeExtensao["claro"];

const temaComTodasAsChaves: TemaDeExtensao = {
  palette: "olive",
  claro: todasAsChaves,
  escuro: { ...todasAsChaves, "--color-bg": "#141611" },
};

function sujeito(
  contribuicoes: Parameters<typeof checkCompatibility>[0]["contributions"],
  perms: Parameters<typeof checkCompatibility>[0]["permissions"] = ["navigation.tasks"],
): Parameters<typeof checkCompatibility>[0] {
  return { host_api: { min: 1, max: 2 }, permissions: perms, contributions: contribuicoes };
}

describe("gancho de tema — a condição do DONO", () => {
  it("quem não escolheu tema recebe `{ css: null }` — nada muda", () => {
    const saida = cssDaExtensaoDeTema(null);
    expect(saida.css).toBeNull();
    expect(saida.motivos).toEqual([]);
  });

  it("sem nenhuma extensão ativa, `temaAplicavel` devolve null", () => {
    expect(temaAplicavel([])).toBeNull();
  });

  it("uma linha que não escolheu paleta não vira candidato", () => {
    const linha = {
      configuracao: { theme: undefined },
      contribuicao: { theme: temaMinimo },
    };
    expect(temaAplicavel([linha])).toBeNull();
  });

  it("o bloco que pinta o produto SÓ casa quando o marcador `[data-tema-extensao]` existe", () => {
    for (const [seletor] of ESCOPO_DO_TEMA_DA_ORGANIZACAO) {
      expect(seletor).toContain("[data-tema-extensao]");
    }
  });

  it("escolher um tema aplica os tokens num bloco escopado pelo marcador", () => {
    const saida = cssDaExtensaoDeTema(temaMinimo);
    expect(saida.css).not.toBeNull();
    // O bloco carrega SÓ dentro do `body:has([data-tema-extensao])` — onde o
    // marcador existe, logo só quem escolheu. E leva os tokens mesmo no tema
    // escuro, casado pelo mesmo marcador.
    expect(saida.css).toContain("body:has([data-tema-extensao])");
    expect(saida.css).toContain("[data-theme=\"dark\"] body:has([data-tema-extensao])");
    expect(saida.css).toContain("--color-bg: #f6f6f4");
    expect(saida.css).toContain("--color-accent-600: #33475b");
    expect(saida.css).toContain("--color-bg: #11151c");
    expect(saida.css).toContain("--color-accent-400: #8fa8be");
  });

  it("um tema com todas as chaves da allowlist sai inteiro", () => {
    const saida = cssDaExtensaoDeTema(temaComTodasAsChaves);
    expect(saida.css).not.toBeNull();
    for (const chave of CHAVES_DE_TOKEN_DO_TEMA) {
      expect(saida.css).toContain(`${chave}:`);
    }
  });
});

describe("gancho de tema — concordância: banco × lado da escolha", () => {
  it("escolher uma paleta que NENHUMA extensão ativa oferece aplica nada", () => {
    const linha = {
      configuracao: { theme: "plum" },
      contribuicao: { theme: { ...temaMinimo, palette: "mist" } },
    };
    expect(temaAplicavel([linha])).toBeNull();
  });

  it("duas extensões disputando o tema aplicam NADA (não depende da ordem do banco)", () => {
    const a = { configuracao: { theme: "mist" }, contribuicao: { theme: temaMinimo } };
    const b = {
      configuracao: { theme: "plum" },
      contribuicao: { theme: { ...temaMinimo, palette: "plum" } },
    };
    expect(temaAplicavel([a, b])).toBeNull();
  });

  it("uma única extensão que oferece a paleta escolhida aplica o tema", () => {
    const linha = { configuracao: { theme: "mist" }, contribuicao: { theme: temaMinimo } };
    expect(temaAplicavel([linha])).toEqual(temaMinimo);
  });
});

describe("gancho de tema — o manifesto: allowlist de chave e régua de forma", () => {
  it("aceita uma contribuição de tema válida", () => {
    expect(esquemaDaContribuicaoDeTema.safeParse(temaMinimo).success).toBe(true);
  });

  it("recusa um token FORA da allowlist no nome", () => {
    const resultado = esquemaDaContribuicaoDeTema.safeParse({
      palette: "mist",
      claro: { "--color-inventado": "#000000" },
      escuro: {},
    });
    expect(resultado.success).toBe(false);
  });

  it("recusa um valor fora da régua de forma (precisão no meio do hex, injetável)", () => {
    const resultado = esquemaDaContribuicaoDeTema.safeParse({
      palette: "mist",
      claro: { "--color-bg": "red; } body { background: url(x" },
      escuro: {},
    });
    expect(resultado.success).toBe(false);
  });

  it("recusa paleta fora da lista fechada", () => {
    const resultado = esquemaDaContribuicaoDeTema.safeParse({
      palette: "neon-matrix",
      claro: { "--color-bg": "#000000" },
      escuro: {},
    });
    expect(resultado.success).toBe(false);
  });

  it("a contribuição de tema exige a permissão `theme.apply` no manifesto", () => {
    const ok = checkCompatibility(
      sujeito({ crm_cards: [], theme: temaMinimo }, ["theme.apply"]),
    );
    expect(ok.compatible).toBe(true);

    const semPermissao = checkCompatibility(
      sujeito({ crm_cards: [], theme: temaMinimo }, ["navigation.tasks"]),
    );
    expect(semPermissao.compatible).toBe(false);
    expect(semPermissao.reason).toBe("permission_unsupported");
  });
});

describe("gancho de tema — o caminho de produção (select do layout → CSS)", () => {
  // A linha no formato que o select de `app/app/layout.tsx` devolve: o tema mora
  // em `manifest.contributions.theme`, não em `manifest.theme`.
  function linhaDoSelect(
    configuracao: Record<string, unknown>,
    artefatos: unknown = { manifest: { contributions: { crm_cards: [], theme: temaMinimo } } },
  ) {
    return {
      configuration: { density: "comfortable", show_description: true, ...configuracao },
      extension_installations: { extension_artifacts: artefatos },
    };
  }

  it("a paleta escolhida, lida pelo select, aplica o tema", () => {
    const linha = linhaBrutaDeTema(linhaDoSelect({ theme: "mist" }));
    expect(temaAplicavel([linha!])).toEqual(temaMinimo);
    expect(cssDaExtensaoDeTema(temaAplicavel([linha!])).css).toContain("--color-bg: #f6f6f4");
  });

  it("o mesmo vale quando o PostgREST embute o artefato como array", () => {
    const linha = linhaBrutaDeTema(
      linhaDoSelect({ theme: "mist" }, [
        { manifest: { contributions: { crm_cards: [], theme: temaMinimo } } },
      ]),
    );
    expect(temaAplicavel([linha!])).toEqual(temaMinimo);
  });

  it("sem `theme` na configuração, a linha não vira candidato", () => {
    expect(linhaBrutaDeTema(linhaDoSelect({}))).toBeNull();
  });
});

describe("gancho de tema — o claro não vaza para o modo escuro", () => {
  // O bloco claro (`body:has([data-tema-extensao])`) casa também no escuro; um
  // token que muda com o tema declarado só no claro pintaria o escuro de claro.
  const soNoClaro: TemaDeExtensao = {
    palette: "mist",
    claro: { "--color-bg": "#f6f6f4" },
    escuro: {},
  };

  it("o CSS recusa um token de fundo declarado só no claro", () => {
    const saida = cssDaExtensaoDeTema(soNoClaro);
    expect(saida.css).toBeNull();
    expect(saida.motivos[0]?.codigo).toBe("sem_par_no_escuro");
  });

  it("o manifesto recusa o mesmo tema", () => {
    expect(esquemaDaContribuicaoDeTema.safeParse(soNoClaro).success).toBe(false);
  });

  it("um stop da rampa só no claro passa — o globals.css dá o mesmo valor nos dois temas", () => {
    const saida = cssDaExtensaoDeTema({
      palette: "mist",
      claro: { "--color-accent-600": "#33475b" },
      escuro: {},
    });
    expect(saida.css).not.toBeNull();
  });
});
