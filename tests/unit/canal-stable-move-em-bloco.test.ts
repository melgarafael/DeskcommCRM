import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O CANAL `stable` MOVE EM BLOCO, NUNCA POR IMAGEM.
 *
 * ## O que aconteceu
 *
 * Medido no registro público durante o corte da v1.12.0 (issue #488), com sonda
 * de DIGEST — a ingênua ("a tag `stable` existe?") devolve `200` nas três e não
 * prova nada, porque `stable` existe desde a 1.11.0:
 *
 *     deskcommcrm          1.12.0   404
 *     deskcommcrm          stable   sha256:0235d02b…   ← 1.11.0
 *     deskcomm-worker      stable   sha256:66c7bde4…   ← 1.12.0
 *     deskcomm-scheduler   stable   sha256:ac6b87cc…   ← 1.12.0
 *
 * Quem instalasse por `stable` naquela janela recebia **app 1.11.0 com worker e
 * scheduler 1.12.0**. Os três serviços saem do mesmo repositório e compartilham
 * código; rodar dois numa versão e o terceiro noutra é um estado que nenhum
 * teste cobre e que ninguém escolheu.
 *
 * A causa foi de FORMA, não de conteúdo: `type=raw,value=stable` vivia dentro do
 * job da matriz, então cada imagem movia o canal sozinha, sem saber se as irmãs
 * conseguiram. O job do app morreu em `Set up Buildx` — antes de compilar
 * qualquer coisa — enquanto worker e scheduler seguiram até o fim e moveram o
 * ponteiro.
 *
 * ## Por que `fail-fast: true` não seria o conserto
 *
 * É o conserto óbvio e ele chega tarde: quando o job do app falhou, as irmãs já
 * tinham publicado e já tinham movido `stable`. Abortá-las não desfaz o que já
 * foi publicado. O que separa os dois atos é publicar por NÚMERO sempre (cada
 * imagem, independente — ninguém instala por um número que o instalador não
 * escreveu) e mover o CANAL num job final, quando o conjunto está completo.
 *
 * ## O que este arquivo prova, e o que ele NÃO prova
 *
 * Ele mede a FORMA do YAML. A prova de comportamento só existe num push de tag
 * real — é o único evento que move `stable` —, e quem a faz é o passo "As três
 * imagens…" de `release.yml`, que agora compara DIGEST e falha alto quando o
 * canal não acompanhou a versão. Aqui se guarda a estrutura que torna aquele
 * passo verdadeiro; lá se guarda o efeito.
 */
const RAIZ = process.cwd();
const publish = readFileSync(join(RAIZ, ".github/workflows/publish-image.yml"), "utf8");
const release = readFileSync(join(RAIZ, ".github/workflows/release.yml"), "utf8");

/**
 * O corpo de um job, do cabeçalho até o próximo job.
 *
 * Começa no bloco `jobs:` de propósito: `on:` tem `  push:` na mesma indentação
 * de um job, e um helper que varra o arquivo inteiro devolveria aquilo como se
 * fosse job.
 */
function job(yml: string, nome: string): string {
  const linhas = yml.split("\n");
  const iJobs = linhas.findIndex((l) => /^jobs:\s*$/.test(l));
  if (iJobs === -1) return "";
  const i = linhas.findIndex((l, n) => n > iJobs && l === `  ${nome}:`);
  if (i === -1) return "";
  const fim = linhas.findIndex((l, n) => n > i && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return linhas.slice(i, fim === -1 ? undefined : fim).join("\n");
}

/** O mesmo corpo, sem os comentários. */
function corpo(yml: string, nome: string): string {
  const t = job(yml, nome);
  expect(t, `o job \`${nome}\` sumiu de publish-image.yml/release.yml`).not.toBe("");
  return t
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * Fonte única para o teste: a matriz que realmente constrói/publica as imagens.
 * Não copie a lista aqui. Se a matriz ganhar uma imagem, todos os laços abaixo
 * precisam ganhar junto ou o gate fica vermelho no mesmo PR.
 */
function imagensDaMatriz(): string[] {
  const t = job(publish, "build-and-push");
  const bloco = /matrix:\s*\n\s+include:\s*\n([\s\S]*?)(?=\n {4}steps:)/.exec(t)?.[1] ?? "";
  return [...bloco.matchAll(/^\s*-\s+name:\s*([A-Za-z0-9._-]+)\s*$/gm)]
    .map((m) => m[1]!)
    .sort();
}

/** Todos os `for img in ...; do` de um corpo de job, como conjuntos ordenados. */
function imagensDosLacos(t: string): string[][] {
  return [...t.matchAll(/for\s+img\s+in\s+([^;]+);\s*do/g)].map((m) =>
    m[1]!
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .sort(),
  );
}

const IMAGENS = imagensDaMatriz();

describe("o canal `stable` move em bloco", () => {
  it("o instrumento está vivo: enxerga os jobs e deriva imagens da matriz", () => {
    // Controle positivo. Sem ele, um helper que parou de casar devolve ""/[] e
    // asserções de ausência poderiam passar por vacuidade — vigiando nada.
    expect(job(publish, "build-and-push")).not.toBe("");
    expect(job(publish, "imagens-ok")).not.toBe("");
    expect(job(publish, "build-and-push")).toContain("matrix:");
    expect(
      IMAGENS.length,
      "não consegui extrair nenhuma imagem da matriz build-and-push",
    ).toBeGreaterThan(0);
    expect(new Set(IMAGENS).size, "a matriz declara nome de imagem duplicado").toBe(IMAGENS.length);
  });

  it("nenhuma imagem move o canal sozinha dentro da matriz", () => {
    const linhas = corpo(publish, "build-and-push")
      .split("\n")
      .filter((l) => l.includes("value=stable"));
    expect(
      linhas,
      "`stable` de volta na matriz: cada imagem volta a mover o canal sem saber das irmãs",
    ).toEqual([]);
  });

  it("o job de promoção espera o build, o boot do app E as imagens de fundo — nem uma a menos", () => {
    const needs = /needs:\s*\[([^\]]*)\]/.exec(corpo(publish, "promover-stable"))?.[1];
    expect(needs, "o job de promoção não declara `needs`").toBeDefined();
    // Conjunto exato, não `toContain`: exigir a presença de um deixaria remover
    // o outro, e é a remoção que reabre o buraco.
    expect(needs?.split(",").map((s) => s.trim()).sort()).toEqual([
      "build-and-push",
      "imagem-do-app-sobe",
      // As imagens de fundo entram na #604: `deskcomm-worker` e
      // `deskcomm-scheduler` construíam e publicavam sem que nenhum job as
      // executasse — e o canal `stable` andava sobre um laço morto.
      "imagens-de-fundo-sobem",
    ]);
  });

  it("a promoção NÃO roda com `always()` — isso a faria promover por cima de uma irmã que falhou", () => {
    expect(corpo(publish, "promover-stable")).not.toMatch(/always\(\)/);
  });

  it("a promoção cobre exatamente as imagens da matriz", () => {
    const lacos = imagensDosLacos(corpo(publish, "promover-stable"));
    expect(lacos, "o job promover-stable deve ter exatamente um `for img in ...`").toHaveLength(1);
    expect(lacos[0], "o laço de promoção divergiu da matriz build-and-push").toEqual(IMAGENS);
  });

  it("a promoção REAPONTA o manifesto publicado, nunca reconstrói", () => {
    // Reconstruir o mesmo commit dá um digest DIFERENTE — foi o que aconteceu na
    // v1.3.0 e fez `stable` e `1.3.0` divergirem com o mesmo `revision`.
    // `imagetools create` copia o índice que já existe.
    expect(corpo(publish, "promover-stable")).toMatch(/imagetools create/);
  });

  it("o canal só se move num push de tag `vX.Y.Z`", () => {
    const cond = / {4}if:\s*(.+)/.exec(corpo(publish, "promover-stable"))?.[1] ?? "";
    // As três condições, e cada uma barra um caminho medido: sem `push`, um
    // dispatch numa release ANTIGA faria `stable` REGREDIR; sem `tag`, um
    // dispatch numa branch moveria o canal; sem o `v`, uma tag de teste o move
    // (o registro já tem uma `quebrada-teste`).
    expect(cond).toContain("github.event_name == 'push'");
    expect(cond).toContain("github.ref_type == 'tag'");
    expect(cond).toContain("startsWith(github.ref_name, 'v')");
  });

  it("a promoção declara o privilégio que ela usa, no menor escopo", () => {
    expect(corpo(publish, "promover-stable")).toMatch(/^ {6}packages: write$/m);
  });
});

describe("o corte da release confere o CANAL, não só a existência da versão", () => {
  it("os dois laços da release cobrem exatamente as imagens da matriz", () => {
    const lacos = imagensDosLacos(corpo(release, "cortar-tag"));
    expect(
      lacos,
      "cortar-tag deve ter dois `for img in ...`: publicação da versão e conferência do stable",
    ).toHaveLength(2);
    for (const [i, imagens] of lacos.entries()) {
      expect(
        imagens,
        `o laço de imagens #${i + 1} de cortar-tag divergiu da matriz build-and-push`,
      ).toEqual(IMAGENS);
    }
  });

  it("compara DIGEST — `stable` e a versão têm de ser o mesmo manifesto", () => {
    const t = corpo(release, "cortar-tag");
    expect(t, "a conferência não lê digest: `200` na tag `stable` é satisfeito desde a 1.11.0").toContain(
      "docker-content-digest",
    );
    expect(t, "a conferência não olha o canal `stable`").toContain("stable");
    expect(t).toMatch(/::error::/);
  });
});
