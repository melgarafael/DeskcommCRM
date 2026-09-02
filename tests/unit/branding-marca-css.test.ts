import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cssDaMarca,
  ESCOPO_DA_INSTALACAO,
  ESCOPO_DA_ORGANIZACAO,
} from "@/lib/branding/css";
import { derivarMarca } from "@/lib/branding/contraste";
import { GRAUS } from "@/lib/branding/rampa";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { camadaDoAmbiente, resolverMarca, type CorResolvida } from "@/lib/branding/resolve";

const RAIZ = process.cwd();
const REGUA = REGUA_DO_PRODUTO;

/** A mesma fixture adversarial do teste de contraste, pelo mesmo motivo. */
const SEMENTES = [
  "#0f172a", "#f5c518", "#ffffff", "#000000", "#808080", "#dc2626", "#22c55e",
  "#f59e0b", "#2563eb", "#14b8a6", "#4b0082", "#e11d48", "#7c3aed", "#1a1f36",
  "#fafafa", "#008069",
] as const;

const corDe = (hex: string): CorResolvida => {
  const cor = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX: hex })], REGUA).cor;
  if (!cor) throw new Error(`fixture ${hex} não resolveu — o teste mediria nada`);
  return cor;
};

/** `{ ":root:root": { "--x": "#fff" }, … }` — os blocos lidos de volta do texto. */
function lerBlocos(css: string): Record<string, Record<string, string>> {
  const saida: Record<string, Record<string, string>> = {};
  for (const bruto of css.split("}")) {
    const abre = bruto.indexOf("{");
    if (abre === -1) continue;
    const seletor = bruto.slice(0, abre).trim();
    const decls: Record<string, string> = {};
    for (const linha of bruto.slice(abre + 1).split(";")) {
      const corte = linha.indexOf(":");
      if (corte === -1) continue;
      decls[linha.slice(0, corte).trim()] = linha.slice(corte + 1).trim();
    }
    saida[seletor] = decls;
  }
  return saida;
}

/** Todo `.ts`/`.tsx` de `app/`, `components/` e `lib/`, em caminho relativo. */
function arquivosDeFonte(): string[] {
  const saida: string[] = [];
  const anda = (rel: string) => {
    for (const entrada of fs.readdirSync(path.join(RAIZ, rel), { withFileTypes: true })) {
      const filho = `${rel}/${entrada.name}`;
      if (entrada.isDirectory()) anda(filho);
      else if (/\.tsx?$/.test(entrada.name)) saida.push(filho);
    }
  };
  for (const raiz of ["app", "components", "lib"]) anda(raiz);
  return saida;
}

describe("serialização — os dois blocos", () => {
  it("emite `:root:root` e `:root:root[data-theme=\"dark\"]`, nesta forma", () => {
    // A especificidade dobrada é o mecanismo, não estilo: `:root` (0,1,0) e
    // `[data-theme="dark"]` (0,1,0) do globals.css empatariam com um `:root`
    // simples, e aí quem decide é a ORDEM do `<link>` — que difere entre dev
    // (HMR) e produção (standalone). Perder o `:root` duplicado é um bug que só
    // aparece num dos dois ambientes.
    const { css } = cssDaMarca(corDe("#2563eb"));
    expect(Object.keys(lerBlocos(css ?? ""))).toEqual([
      ":root:root",
      ':root:root[data-theme="dark"]',
    ]);
  });

  it("os dois blocos declaram EXATAMENTE o mesmo conjunto de tokens", () => {
    // Um token emitido só no bloco claro venceria, com 0,2,0, o valor escuro do
    // globals.css também no tema escuro: a marca vazaria para o tema errado e a
    // alternância ficaria pela metade.
    for (const hex of SEMENTES) {
      const blocos = lerBlocos(cssDaMarca(corDe(hex)).css ?? "");
      const claro = Object.keys(blocos[":root:root"] ?? {}).sort();
      const escuro = Object.keys(blocos[':root:root[data-theme="dark"]'] ?? {}).sort();
      expect(claro, hex).toEqual(escuro);
      expect(claro.length, hex).toBeGreaterThan(0);
    }
  });

  it("emite a rampa inteira, os papéis do accent e a identidade", () => {
    const blocos = lerBlocos(cssDaMarca(corDe("#2563eb")).css ?? "");
    const claro = blocos[":root:root"] ?? {};
    expect(Object.keys(claro).sort()).toEqual(
      [
        "--color-brand",
        ...GRAUS.map((g) => `--color-accent-${g}`),
        "--color-accent",
        "--color-accent-fg",
        "--color-accent-hover",
        "--color-accent-soft",
      ].sort(),
    );
    expect(claro["--color-brand"]).toBe("#2563eb");
  });

  it("o valor por tema difere — senão a alternância estaria morta", () => {
    // Guarda de vacuidade: dois blocos idênticos passariam em tudo acima e
    // deixariam o tema escuro com a cor do claro.
    const blocos = lerBlocos(cssDaMarca(corDe("#2563eb")).css ?? "");
    expect(blocos[":root:root"]?.["--color-accent"]).not.toBe(
      blocos[':root:root[data-theme="dark"]']?.["--color-accent"],
    );
  });

  it("marca acromática ainda emite `--color-brand`", () => {
    // `derivarMarca` diz, no motivo, que "a cor da marca fica só em
    // --color-brand". Sem emitir o token, esse motivo seria mentira.
    for (const hex of ["#808080", "#ffffff", "#000000"]) {
      const blocos = lerBlocos(cssDaMarca(corDe(hex)).css ?? "");
      expect(blocos[":root:root"]?.["--color-brand"], hex).toBe(hex);
    }
  });

  it("sem cor configurada não injeta nada, e isso não é falha", () => {
    expect(cssDaMarca(null)).toEqual({ css: null, motivos: [] });
  });

  it("semente que não pinta emite só a identidade", () => {
    const cor: CorResolvida = { semente: "#2563eb", papel: "marca", derivada: null };
    const blocos = lerBlocos(cssDaMarca(cor).css ?? "");
    expect(Object.keys(blocos[":root:root"] ?? {})).toEqual(["--color-brand"]);
  });
});

describe("o escopo da organização", () => {
  const CLARO = ESCOPO_DA_ORGANIZACAO[0][0];
  const ESCURO = ESCOPO_DA_ORGANIZACAO[1][0];

  it("emite os dois seletores exatos, ancorados no <body>", () => {
    // Os literais estão aqui inteiros de propósito: este é o contrato que a
    // spec de e2e mede no navegador (`getComputedStyle(document.body)`) e o que
    // o marcador de `app/app/layout.tsx` precisa satisfazer. Derivá-los da
    // constante faria o teste concordar com qualquer coisa que ela virasse.
    const { css } = cssDaMarca(corDe("#2563eb"), ESCOPO_DA_ORGANIZACAO);
    expect(Object.keys(lerBlocos(css ?? ""))).toEqual([
      "body:has([data-marca-org])",
      '[data-theme="dark"] body:has([data-marca-org])',
    ]);
  });

  it("nenhum seletor da organização casa o <html>", () => {
    // POR QUE ISTO É O MECANISMO, e não estilo: 7 componentes de `components/ui`
    // usam Radix Portal e nenhum passa `container`, então todos portam para
    // `document.body`. Ancorado no `<body>`, o menu aberto por cima da página
    // herda a cor da organização; ancorado numa div (ou na raiz, que é onde a
    // instalação já manda), a página teria uma cor e o menu, outra.
    for (const [seletor] of ESCOPO_DA_ORGANIZACAO) {
      expect(seletor, seletor).not.toContain(":root");
      expect(/(^|\s)body\b/.test(seletor), seletor).toBe(true);
    }
  });

  it("o gate escuro é combinador DESCENDENTE, não compound", () => {
    // `[data-theme="dark"]` só é escrito no `<html>` (`app/layout.tsx` e
    // `lib/theme.tsx` — as duas únicas escritas no repo). Um compound
    // `body[data-theme="dark"]:has(…)` nunca casaria nada: regra silenciosa,
    // zero erro no console, e a cor escura da organização simplesmente ausente.
    expect(ESCURO).not.toMatch(/body\[data-theme/);
    expect(ESCURO).toMatch(/\[data-theme="dark"\]\s+body/);
  });

  it("o default continua sendo o escopo da instalação", () => {
    // A garantia de que os dois call sites anteriores a esta fase escrevem o
    // MESMO texto de antes: quem pinta o documento inteiro é a instalação, e ela
    // não deveria precisar dizer isso.
    const semArgumento = cssDaMarca(corDe("#2563eb")).css;
    expect(semArgumento).toBe(cssDaMarca(corDe("#2563eb"), ESCOPO_DA_INSTALACAO).css);
    expect(semArgumento?.startsWith(":root:root {\n")).toBe(true);
  });

  it("só o seletor muda — as declarações são idênticas nos dois escopos", () => {
    // Guarda contra a "otimização" de emitir menos tokens no escopo da
    // organização: o conjunto emitido é decisão do motor, não do escopo, e dois
    // conjuntos diferentes divergiriam na primeira mudança de paleta.
    for (const hex of SEMENTES) {
      const instalacao = lerBlocos(cssDaMarca(corDe(hex), ESCOPO_DA_INSTALACAO).css ?? "");
      const organizacao = lerBlocos(cssDaMarca(corDe(hex), ESCOPO_DA_ORGANIZACAO).css ?? "");
      expect(Object.values(organizacao), hex).toEqual(Object.values(instalacao));
    }
  });

  it("os dois blocos da organização declaram o mesmo conjunto de tokens", () => {
    // Aqui a razão NÃO é especificidade, é PROXIMIDADE: os dois blocos casam o
    // `<body>`, que é descendente do `<html>`. Um token emitido só no bloco
    // claro sombrearia o valor escuro do `globals.css` para a subárvore inteira
    // — o accent claro sobreviveria ao `data-theme="dark"` enquanto o resto da
    // paleta trocasse.
    for (const hex of SEMENTES) {
      const blocos = lerBlocos(cssDaMarca(corDe(hex), ESCOPO_DA_ORGANIZACAO).css ?? "");
      const claro = Object.keys(blocos[CLARO] ?? {}).sort();
      const escuro = Object.keys(blocos[ESCURO] ?? {}).sort();
      expect(claro, hex).toEqual(escuro);
      expect(claro.length, hex).toBeGreaterThan(0);
    }
  });

  it("o valor por tema difere também no escopo da organização", () => {
    // Guarda de vacuidade do caso acima: dois blocos idênticos passariam nele e
    // deixariam o tema escuro do tenant com a cor do claro.
    const blocos = lerBlocos(cssDaMarca(corDe("#2563eb"), ESCOPO_DA_ORGANIZACAO).css ?? "");
    expect(blocos[CLARO]?.["--color-accent"]).not.toBe(blocos[ESCURO]?.["--color-accent"]);
  });

  it("a allowlist vale igual no escopo novo", () => {
    // O escopo é parâmetro; a recusa não pode ser. Uma segunda porta de
    // serialização sem a mesma guarda seria a forma clássica de o furo voltar.
    const derivada = derivarMarca("#008069", REGUA);
    const forjada: CorResolvida = {
      semente: "#008069",
      papel: "accent",
      derivada: { ...derivada, claro: { ...derivada.claro, accentSoft: "#fff; } body { x: 1" } },
    };
    expect(cssDaMarca(forjada, ESCOPO_DA_ORGANIZACAO).css).toBeNull();
  });
});

describe("allowlist de FORMA de valor", () => {
  const comSoftForjado = (valor: string): CorResolvida => {
    const derivada = derivarMarca("#008069", REGUA);
    return {
      semente: "#008069",
      papel: "accent",
      derivada: { ...derivada, claro: { ...derivada.claro, accentSoft: valor } },
    };
  };

  it.each([
    ["fecha o bloco e injeta regra", "#fff; } body { display: none"],
    ["fecha a tag <style>", "#fff</style><script>x()</script>"],
    ["expressão CSS com url", "url(https://exemplo.invalid/x.png)"],
    ["cor nomeada", "rebeccapurple"],
    ["var com fallback executável", "var(--x, url(javascript:alert(1)))"],
    ["hex com sobra pendurada", "#ff0000 !important"],
    ["comentário que abre e não fecha", "#fff /*"],
  ])("recusa %s, devolvendo null com motivo", (_rotulo, valor) => {
    const { css, motivos } = cssDaMarca(comSoftForjado(valor));
    // `null`, nunca uma string parcial: devolver "o que deu" seria devolver o
    // bloco até o ponto do furo, com o furo dentro.
    expect(css).toBeNull();
    expect(motivos.map((m) => m.codigo)).toContain("valor_fora_da_allowlist");
    expect(motivos.find((m) => m.codigo === "valor_fora_da_allowlist")?.alvo).toBe(
      "--color-accent-soft",
    );
  });

  it("aceita as três formas que o produto de fato emite", () => {
    for (const bom of ["#abc", "#a1b2c3", "rgb(1, 2, 3)", "rgba(73, 177, 152, 0.16)"]) {
      expect(cssDaMarca(comSoftForjado(bom)).css, bom).not.toBeNull();
    }
  });

  it("toda a fixture adversarial serializa, e nada na saída é suspeito", () => {
    // Guarda de vacuidade da allowlist: uma regra que recusasse tudo passaria
    // nos testes de recusa acima e deixaria o produto sem marca nenhuma.
    for (const hex of SEMENTES) {
      const { css, motivos } = cssDaMarca(corDe(hex));
      expect(css, hex).not.toBeNull();
      expect(motivos.map((m) => m.codigo), hex).not.toContain("valor_fora_da_allowlist");
      expect(css ?? "", hex).not.toContain("<");
      expect(css ?? "", hex).not.toContain(";}");
    }
  });
});

describe("o que a derivação move e o CSS ainda não emite", () => {
  it("toda semântica deslocada vira um motivo de não-serialização", () => {
    // O par com rótulo: a derivação DIZ que girou `--color-success`; se o CSS
    // não a emite, o log precisa dizer isso também — senão o motivo descreve um
    // movimento que a tela não faz.
    const cor = corDe("#22c55e");
    const movidas = (cor.derivada?.motivos ?? []).filter(
      (m) => m.codigo === "semantica_deslocada",
    );
    expect(movidas.length).toBeGreaterThan(0);
    const naoEmitidas = cssDaMarca(cor).motivos.filter(
      (m) => m.codigo === "token_nao_serializado",
    );
    expect(naoEmitidas).toHaveLength(movidas.length);
  });
});

describe("guardas de mecanismo", () => {
  it("ninguém escreve a cor com style.setProperty", () => {
    // POR QUE ESTE TESTE EXISTE: `document.documentElement.style.setProperty` é
    // o caminho curto e é uma armadilha — declaração inline vence `:root` E
    // `[data-theme="dark"]` ao mesmo tempo, então o valor de um tema passa a
    // valer nos dois. A alternância continua trocando o atributo, o resto da
    // paleta troca, e só o accent fica preso: quebra sem sintoma visível.
    const alvos = ["lib/branding/css.ts", "lib/branding/resolve.ts", "app/layout.tsx"];
    for (const alvo of alvos) {
      const fonte = fs.readFileSync(path.join(RAIZ, alvo), "utf8");
      const linhas = fonte
        .split("\n")
        .filter((l) => /style\.setProperty/.test(l) && !l.trimStart().startsWith("*"));
      expect(linhas, `${alvo}: ${linhas.join(" | ")}`).toEqual([]);
    }
  });

  it("nenhum call site passa seletor como string solta", () => {
    // POR QUE ESTE TESTE EXISTE: o seletor entra direto em `montarBloco` sem
    // passar por validação nenhuma — a allowlist cobre nome de token e forma de
    // VALOR, e a rede de segurança do fim só pega `<` e `;}` (não pega um `}`
    // sozinho). O tipo já é a união dos dois literais, mas quem escreve um
    // `as const` novo no arquivo da própria tela não esbarra no typecheck: aqui
    // a regra fica escrita num lugar em que alguém a encontra.
    const chamadas: string[] = [];
    const forasteiros: string[] = [];
    for (const alvo of arquivosDeFonte()) {
      const fonte = fs.readFileSync(path.join(RAIZ, alvo), "utf8");
      // `(?<!function )` deixa de fora a DECLARAÇÃO em `lib/branding/css.ts`,
      // cuja assinatura casaria e apareceria como se fosse chamada com escopo
      // desconhecido — o instrumento acusando a si mesmo.
      for (const chamada of fonte.match(/(?<!function )cssDaMarca\([^)]*\)/g) ?? []) {
        chamadas.push(`${alvo}: ${chamada}`);
        const escopo = chamada.split(",")[1]?.trim().replace(/\)$/, "");
        if (escopo === undefined) continue;
        if (escopo === "ESCOPO_DA_INSTALACAO" || escopo === "ESCOPO_DA_ORGANIZACAO") continue;
        forasteiros.push(`${alvo}: ${chamada}`);
      }
    }
    // Controle positivo: uma varredura que não achasse chamada nenhuma passaria
    // no `toEqual([])` acima sem medir nada. Quatro é o que existe hoje — o
    // layout raiz, o layout de `/app` e as duas telas de marca.
    expect(chamadas.length, chamadas.join("\n")).toBeGreaterThanOrEqual(4);
    expect(forasteiros).toEqual([]);
  });

  it("o layout injeta o bloco no <head>, antes do script de tema", () => {
    // Zero flash depende disso: o bloco é HTML no primeiro byte. Se ele descer
    // para o <body> ou virar efeito de cliente, a tela pinta a cor do produto e
    // troca depois — que é exatamente o que o self-hoster reporta como "piscou".
    const layout = fs.readFileSync(path.join(RAIZ, "app/layout.tsx"), "utf8");
    const head = layout.indexOf("<head>");
    const estilo = layout.indexOf("<EstiloDaMarca />");
    const tema = layout.indexOf("THEME_INIT_SCRIPT }}");
    expect(head).toBeGreaterThan(-1);
    expect(estilo).toBeGreaterThan(head);
    expect(estilo).toBeLessThan(layout.indexOf("</head>"));
    expect(estilo).toBeLessThan(tema);
  });

  it("o layout de /app envolve a árvore inteira no marcador do escopo", () => {
    // POR QUE ESTE TESTE EXISTE: o seletor é `body:has([data-marca-org])`. Sem o
    // marcador no DOM a regra não casa NADA — a cor é resolvida, o bloco vai
    // para a página, e nenhum pixel muda. Falha sem sintoma, do tipo que se
    // descobre pelo cliente reclamando que "a cor não funciona".
    const layout = fs.readFileSync(path.join(RAIZ, "app/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<div data-marca-org="" className="contents">/);
    // `contents` porque o elemento não pode gerar caixa: com uma div normal, o
    // shell (`flex min-h-screen`) passaria a ter um ancestral a mais no box tree
    // e a altura de tela inteira deixaria de valer.
    const marcador = layout.indexOf("data-marca-org");
    // ENVOLVE TUDO, e não só o shell: a div do `AppShell` é irmã dos banners e é
    // SUBSTITUÍDA quando o `MfaEnrollGate` bloqueia. O admin de tenant veria a
    // tela de cadastro de MFA — a primeira dele — com a cor da instalação.
    expect(marcador).toBeGreaterThan(-1);
    expect(marcador).toBeLessThan(layout.indexOf("<ImpersonateBanner"));
    expect(marcador).toBeLessThan(layout.indexOf("MfaEnrollGate enrolled"));
  });

  it("o bloco da organização é emitido DENTRO da subárvore, não na raiz", () => {
    const layout = fs.readFileSync(path.join(RAIZ, "app/app/layout.tsx"), "utf8");
    const marcador = layout.indexOf('<div data-marca-org=""');
    const estilo = layout.indexOf("<EstiloDaMarcaDaOrganizacao");
    // Vacuidade: sem o marcador, `-1 < estilo` seria verde e este caso passaria
    // a não ordenar coisa nenhuma.
    expect(marcador).toBeGreaterThan(-1);
    expect(estilo).toBeGreaterThan(marcador);
    // E o layout RAIZ não conhece o escopo da organização: emitir o bloco lá o
    // faria sobreviver ao logout, que é Server Action + `redirect` — navegação
    // client-side, sem full reload, sem o `<head>` desmontar.
    const raiz = fs.readFileSync(path.join(RAIZ, "app/layout.tsx"), "utf8");
    expect(raiz).not.toContain("ESCOPO_DA_ORGANIZACAO");
  });

  it("o bloco da organização tem id próprio e não é içado pelo React", () => {
    const fonte = fs.readFileSync(
      path.join(RAIZ, "app/app/_components/EstiloDaMarcaDaOrganizacao.tsx"),
      "utf8",
    );
    // O `id` é o que distingue este bloco do da instalação (`marca-instalacao`,
    // no `<head>`) para o suporte, para o diagnóstico e para a spec de e2e — que
    // afirma a AUSÊNCIA dele em `/login` como uma das três provas de não-vazamento.
    expect(fonte).toContain('<style id="marca-organizacao"');
    // `href` e `precedence` são exatamente as duas props que fazem o React 19
    // IÇAR um `<style>` para o `<head>` e gerenciá-lo como recurso. Com elas, o
    // bloco deixaria de desmontar junto com a subárvore de `/app`.
    const semComentario = fonte
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("*"))
      .join("\n");
    expect(semComentario).not.toMatch(/\bhref=/);
    expect(semComentario).not.toMatch(/\bprecedence\b/);
  });
});
