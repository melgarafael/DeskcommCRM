/**
 * TODA IMAGEM QUE O PRODUTO PUBLICA TEM DE SER CONSTRUÍDA EM PR.
 *
 * Em 20/09/2026 a quarta imagem do produto (`deskcomm-voice-agent`, do #677)
 * entrou na `main` sem NUNCA ter sido construída — e o `imagens-ok`, que é
 * check obrigatório, ficou VERDE. Só no primeiro build de verdade, já na
 * `main`, apareceu o defeito: a receita dela não copiava `patches/`, e o
 * `pnpm install` morria com ENOENT. A esteira de publicação ficou travada, e
 * travada ela leva junto qualquer hotfix.
 *
 * O MECANISMO, e é o que esta cerca existe para impedir:
 *
 *   `build-and-push` tem a matriz com TODAS as imagens, mas tem também
 *   `if: github.event_name != 'pull_request'` — em PR ele sai `skipped`.
 *
 *   Quem roda em PR é `imagem-do-app-sobe` (só `Dockerfile`) e
 *   `imagens-de-fundo-sobem` (só `worker` e `scheduler`), e os dois nomeiam a
 *   receita À MÃO. Uma imagem nova não entra em lista nenhuma sozinha.
 *
 * Então o conjunto "publicado" cresce com a matriz e o conjunto "construído em
 * PR" só cresce quando alguém lembra. Esta cerca compara as DUAS grandezas do
 * próprio arquivo — nenhum número escrito aqui, nada que envelheça: quem
 * acrescenta imagem à matriz e esquece o gate é reprovado no PR em que a
 * imagem nasce, não uma semana depois na `main`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW = ".github/workflows/publish-image.yml";
const yml = readFileSync(WORKFLOW, "utf8");

/**
 * O trecho de um job, do cabeçalho até o próximo job. Recorta por JOB, não pela
 * forma `matrix:`/`include:`: quando `imagem-do-app-sobe` ganhou matriz de
 * arquitetura (#1938), o recorte por forma passou a engolir o job inteiro, e o
 * `Dockerfile` do app sumiu do conjunto "construído em PR".
 */
function recorteDoJob(texto: string, nome: string): { antes: string; job: string; depois: string } {
  const linhas = texto.split("\n");
  const iJobs = linhas.findIndex((l) => /^jobs:\s*$/.test(l));
  const i = linhas.findIndex((l, n) => n > iJobs && l === `  ${nome}:`);
  if (iJobs === -1 || i === -1) return { antes: texto, job: "", depois: "" };
  const achado = linhas.findIndex((l, n) => n > i && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  const fim = achado === -1 ? linhas.length : achado;
  return {
    antes: linhas.slice(0, i).join("\n"),
    job: linhas.slice(i, fim).join("\n"),
    depois: linhas.slice(fim).join("\n"),
  };
}

/** As receitas que a matriz de `build-and-push` publica. */
function receitasPublicadas(texto = yml): string[] {
  const { job } = recorteDoJob(texto, "build-and-push");
  return [...job.matchAll(/^\s+dockerfile:\s*(\S+)\s*$/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/**
 * As receitas que algum job constrói EM PR.
 *
 * `build-and-push` é excluído de propósito: ele é justamente o que não roda em
 * PR, e incluí-lo faria a cerca nascer verde medindo a si mesma.
 */
function receitasConstruidasEmPr(texto = yml): string[] {
  const { antes, depois } = recorteDoJob(texto, "build-and-push");
  return [...`${antes}\n${depois}`.matchAll(/^\s+file:\s*(Dockerfile\S*)\s*$/gm)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  );
}

type Combinacao = Record<string, string>;

/**
 * Os jobs que a matriz de `build-and-push` gera, pela regra documentada do
 * GitHub para `matrix.include`: cada item é somado a toda combinação cujos
 * valores ORIGINAIS ele não contradiz — e pode sobrescrever o que um item
 * anterior somou; se não cabe em nenhuma, vira combinação nova.
 *
 * É isto que pega o defeito do #1938: com `arch` como único eixo e as imagens
 * só no `include`, cada item sobrescrevia o anterior e sobravam 2 jobs, os dois
 * da última imagem. Nenhum check de PR vê isso — o job é pulado em PR.
 */
function jobsDaMatriz(texto = yml): Combinacao[] {
  const linhas = recorteDoJob(texto, "build-and-push").job.split("\n");
  const iMatriz = linhas.findIndex((l) => /^ {6}matrix:\s*$/.test(l));
  if (iMatriz === -1) return [];
  const eixos: Record<string, string[]> = {};
  const itens: Combinacao[] = [];
  for (const l of linhas.slice(iMatriz + 1)) {
    if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
    if (!/^ {7,}/.test(l)) break;
    const eixo = /^ {8}([a-z_]+):\s*\[(.*)\]\s*$/.exec(l);
    const novoItem = /^ {10}- ([a-z_]+):\s*(.+?)\s*$/.exec(l);
    const campo = /^ {12}([a-z_]+):\s*(.+?)\s*$/.exec(l);
    if (eixo?.[1] && eixo[2] !== undefined) eixos[eixo[1]] = eixo[2].split(",").map((v) => v.trim());
    else if (novoItem?.[1] && novoItem[2]) itens.push({ [novoItem[1]]: novoItem[2] });
    else if (campo?.[1] && campo[2] && itens.length > 0) Object.assign(itens[itens.length - 1] ?? {}, { [campo[1]]: campo[2] });
  }
  const chaves = Object.keys(eixos);
  let combinacoes: Combinacao[] = chaves.length > 0 ? [{}] : [];
  for (const k of chaves) {
    combinacoes = combinacoes.flatMap((c) => (eixos[k] ?? []).map((v) => ({ ...c, [k]: v })));
  }
  const originais = combinacoes.map((c) => ({ ...c }));
  for (const item of itens) {
    let coube = false;
    combinacoes.forEach((c, n) => {
      const original = originais[n] ?? {};
      if (Object.entries(item).every(([k, v]) => !(k in original) || original[k] === v)) {
        Object.assign(c, item);
        coube = true;
      }
    });
    if (!coube) combinacoes.push({ ...item });
  }
  return combinacoes;
}

describe("toda imagem publicada é construída em PR", () => {
  it("o instrumento acha o que precisa achar (guarda de vacuidade)", () => {
    // Sem isto, um regex que parou de casar devolveria dois conjuntos vazios e
    // a cerca ficaria verde sem medir nada.
    expect(receitasPublicadas().length).toBeGreaterThanOrEqual(2);
    expect(receitasConstruidasEmPr().length).toBeGreaterThanOrEqual(2);
    expect(jobsDaMatriz().length).toBeGreaterThanOrEqual(2);
  });

  it("nenhuma receita da matriz fica sem build em PR", () => {
    const emPr = new Set(receitasConstruidasEmPr());
    const descobertas = receitasPublicadas().filter((r) => !emPr.has(r));

    expect(
      descobertas,
      `Estas receitas são PUBLICADAS e nunca construídas em PR: ${descobertas.join(", ")}.\n` +
        `O \`imagens-ok\` fica verde e o defeito só aparece na \`main\`, com a esteira de\n` +
        `publicação travada. Acrescente o build delas a um job que rode em PR\n` +
        `(\`imagem-do-app-sobe\` ou \`imagens-de-fundo-sobem\`) em ${WORKFLOW}.`,
    ).toEqual([]);
  });

  it("a matriz gera um job por receita E por arquitetura — nenhum item do include engole o anterior", () => {
    const jobs = jobsDaMatriz();
    const pares = new Set(jobs.map((j) => `${j.dockerfile ?? "?"} ${j.arch ?? "?"}`));
    const esperado = receitasPublicadas().flatMap((r) => ["amd64", "arm64"].map((a) => `${r} ${a}`));
    expect(
      [...pares].sort(),
      "A matriz de build-and-push não gera todas as combinações imagem × arquitetura. Declare `name` e\n" +
        "`arch` como eixos e deixe o `include` só completar `dockerfile`/`title` casando pelo `name`.",
    ).toEqual(esperado.sort());
    expect(jobs).toHaveLength(esperado.length);
  });

  it("o instrumento enxerga a violação quando ela existe (controle negativo)", () => {
    // Uma receita na matriz que nenhum job de PR nomeia tem de ser pega.
    const sabotado = yml.replace(
      /(matrix:\s*\n\s*include:\s*\n)/,
      "$1          - name: deskcomm-inventada\n            dockerfile: Dockerfile.inventada\n",
    );
    const emPr = new Set(receitasConstruidasEmPr(sabotado));
    expect(receitasPublicadas(sabotado).filter((r) => !emPr.has(r))).toContain("Dockerfile.inventada");
  });

  it("o modelo da matriz enxerga o defeito do #1938 (controle negativo)", () => {
    // A forma que o #1938 trouxe: `arch` como único eixo, imagens só no include.
    const sabotado = yml.replace(/^ {8}name: \[[^\n]*\]\n/m, "");
    expect(sabotado).not.toBe(yml);
    const jobs = jobsDaMatriz(sabotado);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.name)).size).toBe(1);
  });
});
