// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Catraca: rota que monta a resposta à mão tem de carimbar o `X-Request-Id`.
 *
 * `ok()`/`fail()` já devolvem o id da requisição, mas uma rota que responde com
 * `new Response(...)`, `NextResponse.json(...)` ou `NextResponse.redirect(...)`
 * não passa por eles — e são várias saídas por handler (arquivo, QR, stream,
 * redirect, webhook). O `proxy.ts` não pode cobrir isso: ele roda ANTES de a
 * rota escolher o id e, carimbando por cima, publicava um id que não estava em
 * log nenhum.
 *
 * Então a regra é a da borda do handler: `rotaComIdDaRequisicao`, ou o carimbo
 * explícito (`X-Request-Id`) para quem tem um id próprio. Este teste é o que
 * impede a próxima rota escrita à mão de sair sem cabeçalho — a lista de
 * exceções é vazia de propósito; quem precisar de uma, escreve o motivo aqui.
 */

const RAIZ = process.cwd();
const APP_API = join(RAIZ, "app", "api");

/** Monta resposta sem passar pelos wrappers. */
const RESPOSTA_A_MAO = /new Response\(|new NextResponse\(|NextResponse\.json\(|NextResponse\.redirect\(/;

/** Carimba o id: pelo wrapper canônico ou escrevendo o cabeçalho à mão. */
const CARIMBA = /id-da-requisicao|X-Request-Id/i;

function rotas(diretorio: string): string[] {
  const achadas: string[] = [];
  for (const entrada of readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = join(diretorio, entrada.name);
    if (entrada.isDirectory()) achadas.push(...rotas(caminho));
    else if (entrada.name === "route.ts") achadas.push(caminho);
  }
  return achadas;
}

describe("toda rota que monta resposta à mão carimba o X-Request-Id", () => {
  const arquivos = rotas(APP_API);
  const aMao = arquivos.filter((arq) => RESPOSTA_A_MAO.test(readFileSync(arq, "utf8")));

  it("a varredura enxerga as rotas (senão o teste passaria sem medir nada)", () => {
    expect(arquivos.length).toBeGreaterThan(100);
    expect(aMao.length).toBeGreaterThan(30);
  });

  it("nenhuma fica sem carimbo", () => {
    const semCarimbo = aMao
      .filter((arq) => !CARIMBA.test(readFileSync(arq, "utf8")))
      .map((arq) => relative(RAIZ, arq))
      .sort();

    expect(semCarimbo).toEqual([]);
  });
});
