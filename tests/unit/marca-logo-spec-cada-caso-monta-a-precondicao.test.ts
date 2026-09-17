/**
 * CADA CASO DE `marca-logo.spec.ts` MONTA A PRÓPRIA PRECONDIÇÃO (issue #306).
 *
 * ── O defeito que este arquivo guarda ───────────────────────────────────────
 *
 * A spec do logo era `mode: "serial"` e os casos se encadeavam DE PROPÓSITO: o (2)
 * media o logo que o (1) tinha subido, o (4) começava asseverando o logo que o (3)
 * tinha subido, o (5) removia o do (3) e o (6) o que o (1) deixou. O preço foi
 * medido pelo autor da issue: **4 reprovações em 8 execuções em dois dias, em
 * casos DIFERENTES** — e o (4) reprovando na PRECONDIÇÃO ("a barra precisa entrar
 * neste caso COM logo da empresa"), derrubando PRs que não tocam marca.
 *
 * ── Por que a régua é o TEXTO da spec, e não o comportamento ────────────────
 *
 * O que se quer provar é o estado de partida de cada caso, e o único jeito de
 * observar isso por comportamento é rodar a suíte — que precisa de Supabase local
 * e build (o job `e2e`, uma vez por PR). O `test:unit` não sobe esse rig, e é
 * exatamente a mesma razão declarada em
 * `tests/unit/marca-logo-spec-ancora-a-rota.test.ts` (issue #274) para a âncora.
 * A régua possível aqui é a fonte, e o que ela cobra são PROPRIEDADES: nenhum
 * caso herda estado, a barra medida é a que o próprio caso montou, e o modo serial
 * (que pula os casos seguintes depois de um estouro e esconde qual quebrou) não
 * volta.
 *
 * ⚠️ Ela NÃO prova que a spec passa: prova que ela não voltou a depender de
 * outro caso. Execução de tela é o job `e2e`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const CAMINHO_SPEC = path.join(RAIZ, "tests/e2e/marca-logo.spec.ts");

const SPEC = readFileSync(CAMINHO_SPEC, "utf8");

interface Caso {
  readonly n: number;
  readonly titulo: string;
  readonly corpo: string;
}

/**
 * Os casos `test("(N) …")` do arquivo, na ordem, com o corpo de cada um.
 *
 * O corpo vai até o PRÓXIMO `test.`/`test.afterAll(`, e não até o fim do arquivo:
 * o `afterAll` também sobe e remove estado, e contá-lo como parte do último caso
 * faria a checagem de "todo caso sobe o que mede" passar por causa do hook.
 */
function casos(fonte: string): Caso[] {
  const aberturas = [...fonte.matchAll(/^ {2}test[.(]/gm)].map((m) => m.index!);
  const encontrados: Caso[] = [];
  for (let i = 0; i < aberturas.length; i++) {
    const inicio = aberturas[i]!;
    const fim = aberturas[i + 1] ?? fonte.length;
    const bloco = fonte.slice(inicio, fim);
    const cabecalho = /^ {2}test\("\((\d)\)/.exec(bloco);
    if (!cabecalho) continue;
    encontrados.push({
      n: Number(cabecalho[1]),
      titulo: bloco.split("\n")[0]!.trim(),
      corpo: bloco,
    });
  }
  return encontrados;
}

/** A subida de uma camada, inline ou pelo helper da precondição. */
const SUBIDA = /subirLogoDaCamada\(|await subir\(/;
/** A leitura do logo da barra lateral. */
const MEDICAO_DA_BARRA = /barraMostraLogoDe\(|logoDaBarra\(/;

describe("marca-logo.spec.ts: cada caso monta a própria precondição", () => {
  const blocos = casos(SPEC);

  it("a leitura da fonte acha os seis casos, e na ordem", () => {
    expect(
      blocos.map((c) => c.n),
      "a régua deste arquivo é a FONTE da spec: se ela mudou de forma a ponto de os " +
        "casos não serem mais reconhecidos, esta guarda está cega — e uma guarda cega " +
        "passa em tudo",
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("não voltou para `mode: \"serial\"`", () => {
    // O serial ENCADEIA por contrato: um estouro faz os casos seguintes saírem como
    // "did not run", o relatório diz que UMA coisa quebrou e esconde se as outras
    // cinco passariam. Com cada caso montando a própria precondição, ordenar deixou
    // de ser premissa; a ordem continua garantida por `workers: 1` e
    // `fullyParallel: false` no `playwright.config.ts` (paralelização por arquivo).
    expect(
      SPEC,
      "a spec voltou ao modo serial: ele pula os casos seguintes depois de um estouro, " +
        "e é assim que a reprovação deixa de dizer QUAL caso quebrou",
    ).not.toMatch(/test\.describe\.configure\(\s*\{\s*mode:\s*"serial"/);
  });

  it("todo caso sobe ao menos uma camada — nenhum espera o estado que outro deixou", () => {
    for (const caso of blocos) {
      expect(
        SUBIDA.test(caso.corpo),
        `${caso.titulo}: este caso não sobe camada nenhuma — ele depende do estado que ` +
          `outro caso deixou, que é o defeito da issue #306`,
      ).toBe(true);
    }
  });

  it("a barra medida é a barra que o caso montou (a subida vem antes da medição)", () => {
    for (const caso of blocos) {
      const medicao = caso.corpo.search(MEDICAO_DA_BARRA);
      if (medicao === -1) continue; // caso que não mede a barra: nada a exigir aqui
      const subida = caso.corpo.search(SUBIDA);
      expect(
        subida,
        `${caso.titulo}: mede o logo da barra sem ter subido nada antes — a barra que ele ` +
          `mediu é a que outro caso pintou`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        subida,
        `${caso.titulo}: mede a barra ANTES de subir o próprio logo — a precondição dele ` +
          `volta a ser o que estava lá`,
      ).toBeLessThan(medicao);
    }
  });
});
