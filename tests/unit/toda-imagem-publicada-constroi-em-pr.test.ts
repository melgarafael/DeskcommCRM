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

/** As receitas que a matriz de `build-and-push` publica. */
function receitasPublicadas(): string[] {
  const matriz = yml.match(/matrix:\s*\n\s*include:\s*\n((?:\s+-?\s+\w[^\n]*\n)+)/);
  if (!matriz) return [];
  const bloco = matriz[1] ?? "";
  return [...bloco.matchAll(/dockerfile:\s*(\S+)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/**
 * As receitas que algum job constrói EM PR.
 *
 * `build-and-push` é excluído de propósito: ele é justamente o que não roda em
 * PR, e incluí-lo faria a cerca nascer verde medindo a si mesma.
 */
function receitasConstruidasEmPr(): string[] {
  const semMatriz = yml.replace(/matrix:\s*\n\s*include:\s*\n(?:\s+-?\s+\w[^\n]*\n)+/g, "");
  return [...semMatriz.matchAll(/^\s+file:\s*(Dockerfile\S*)\s*$/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe("toda imagem publicada é construída em PR", () => {
  it("o instrumento acha o que precisa achar (guarda de vacuidade)", () => {
    // Sem isto, um regex que parou de casar devolveria dois conjuntos vazios e
    // a cerca ficaria verde sem medir nada.
    expect(receitasPublicadas().length).toBeGreaterThanOrEqual(2);
    expect(receitasConstruidasEmPr().length).toBeGreaterThanOrEqual(2);
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

  it("o instrumento enxerga a violação quando ela existe (controle negativo)", () => {
    // Uma receita na matriz que nenhum job de PR nomeia tem de ser pega.
    const sabotado = yml.replace(
      /(matrix:\s*\n\s*include:\s*\n)/,
      "$1          - name: deskcomm-inventada\n            dockerfile: Dockerfile.inventada\n",
    );
    const matriz = sabotado.match(/matrix:\s*\n\s*include:\s*\n((?:\s+-?\s+\w[^\n]*\n)+)/);
    const bloco = matriz?.[1] ?? "";
    const publicadas = [...bloco.matchAll(/dockerfile:\s*(\S+)/g)].flatMap((m) => (m[1] ? [m[1]] : []));
    const emPr = new Set(receitasConstruidasEmPr());

    expect(publicadas.filter((r) => !emPr.has(r))).toContain("Dockerfile.inventada");
  });
});
