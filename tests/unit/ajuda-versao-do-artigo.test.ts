import { describe, expect, it } from "vitest";

import {
  ARTIGOS_DE_AJUDA,
  BLOCOS_DE_AJUDA,
  artigosSemVersao,
  compararVersoes,
  instalacaoAnteriorAoArtigo,
  numerosDaVersao,
  rotuloDaVersao,
  type ItemDeAjuda,
} from "@/lib/ajuda/hub";

/**
 * A VERSÃO DO ARTIGO DE AJUDA — comparação e CATRACA (#3567, F4).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O hub não dizia a que versão cada artigo pertencia. Quem estava na v1.90 lia
 * um artigo escrito para a v1.97 e seguia um caminho que não existia na tela
 * dele — "afirmar o que não conferi", do lado de quem lê.
 *
 * ─── O que este arquivo prova, e o que ele NÃO prova ───────────────────────
 *
 * Prova a RÉGUA (a comparação, com as tolerâncias medidas) e a CATRACA (nenhum
 * artigo existe sem versão legível). Não prova o desenho do aviso na tela: isso
 * é `ajuda-avisa-versao-do-artigo.test.tsx`, que monta o componente.
 *
 * ─── Por que a catraca testa a lista REAL, e não uma sintética ─────────────
 *
 * É a lista real que vai para a tela. Um teste com três artigos de mentira
 * continuaria verde no dia em que alguém acrescentasse o quarto sem `desde`.
 * Aqui, artigo novo entra na conta no commit em que é escrito, sem ninguém
 * precisar lembrar deste arquivo.
 */

describe("comparação de versão da instalação com a do artigo", () => {
  it("ordena por número, não por texto (1.100 é mais novo que 1.99)", () => {
    expect(compararVersoes("1.100.0", "1.99.0")).toBe(1);
    expect(compararVersoes("1.9.0", "1.10.0")).toBe(-1);
  });

  it("tolera o `v` da tag — a versão chega das duas formas", () => {
    expect(compararVersoes("v1.90.0", "1.97.0")).toBe(-1);
    expect(compararVersoes("v1.97.0", "v1.97.0")).toBe(0);
    expect(rotuloDaVersao(" v1.97.0 ")).toBe("1.97.0");
  });

  it("versão incompleta é a mesma versão: `1.90` = `1.90.0`", () => {
    expect(numerosDaVersao("1.90")).toEqual([1, 90]);
    expect(compararVersoes("1.90", "1.90.0")).toBe(0);
    expect(compararVersoes("1.90", "1.90.1")).toBe(-1);
  });

  it("sufixo de pré-release/construtor não muda a posição da versão", () => {
    // O repo carrega tag de fork (`v1.1.1-jmpo.1`); comparar o sufixo exigiria
    // uma régua de semver que o projeto não tem.
    expect(compararVersoes("1.93.0-rc.1", "1.93.0")).toBe(0);
    expect(compararVersoes("1.97.0+jmpo.1", "1.96.0")).toBe(1);
  });

  it.each([
    ["SHA de instalação fora de release", "abc1234"],
    ["texto qualquer", "depois"],
    ["vazio", ""],
    ["nulo", null],
    ["indefinido", undefined],
  ])("%s NÃO é versão legível: comparação `null`, nunca zero", (_caso, valor) => {
    expect(numerosDaVersao(valor)).toBeNull();
    expect(compararVersoes(valor, "1.97.0")).toBeNull();
  });
});

describe("a instalação está atrás do artigo?", () => {
  it("anterior avisa; igual e posterior não", () => {
    expect(instalacaoAnteriorAoArtigo("1.90.0", "1.97.0")).toBe(true);
    expect(instalacaoAnteriorAoArtigo("1.97.0", "1.97.0")).toBe(false);
    expect(instalacaoAnteriorAoArtigo("1.98.0", "1.97.0")).toBe(false);
  });

  it("versão desconhecida NÃO marca o artigo como antigo — ausência não é prova", () => {
    // O caso da rota que falhou. Marcar aqui ensinaria a ignorar a marca.
    expect(instalacaoAnteriorAoArtigo(null, "1.97.0")).toBe(false);
    expect(instalacaoAnteriorAoArtigo(undefined, "1.97.0")).toBe(false);
    expect(instalacaoAnteriorAoArtigo("abc1234", "1.97.0")).toBe(false);
    expect(instalacaoAnteriorAoArtigo("", "1.97.0")).toBe(false);
  });
});

describe("a catraca: nenhum artigo existe sem a marca de versão", () => {
  it("todo artigo do hub declara uma versão legível", () => {
    expect(ARTIGOS_DE_AJUDA.length).toBeGreaterThan(0);
    expect(artigosSemVersao(ARTIGOS_DE_AJUDA)).toEqual([]);
    // A lista plana é a mesma coisa que os blocos: se alguém criar um bloco e
    // não o ligar em `ARTIGOS_DE_AJUDA`, a catraca estaria medindo menos do que
    // a tela mostra.
    expect(ARTIGOS_DE_AJUDA).toHaveLength(
      BLOCOS_DE_AJUDA.reduce((total, bloco) => total + bloco.itens.length, 0),
    );
  });

  it("⭐ apagar a marca de um artigo REPROVA — o teste morde", () => {
    // A prova da catraca não pode ser "hoje está tudo marcado": ela tem de
    // acusar quem apagar uma marca. O `as unknown as` é de propósito — é o
    // caminho que o tipo não barra (dado montado à mão, JSON, `as ItemDeAjuda[]`).
    const primeiro = ARTIGOS_DE_AJUDA[0]!;
    const semMarca: Record<string, unknown> = { ...primeiro };
    delete semMarca.desde;
    const lista = [semMarca as unknown as ItemDeAjuda, ...ARTIGOS_DE_AJUDA.slice(1)];

    expect(artigosSemVersao(lista)).toEqual([primeiro.texto]);
  });

  it("versão que não é versão conta como marca ausente", () => {
    const comTexto = [{ ...ARTIGOS_DE_AJUDA[0]!, desde: "quando der" }];

    expect(artigosSemVersao(comTexto)).toEqual([ARTIGOS_DE_AJUDA[0]!.texto]);
  });
});
