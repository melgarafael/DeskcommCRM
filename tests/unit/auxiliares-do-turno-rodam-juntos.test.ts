/**
 * Os dois classificadores auxiliares do turno rodam EM PARALELO.
 *
 * Eram sequenciais, e a espera ia inteira para o relógio de quem mandou a
 * mensagem: medido na instalação do piloto em 10/09/2026, `stage_classifier`
 * levou 3,3s de média e `jailbreak_detect` 3,9s — 7,2 segundos antes de o
 * turno sequer começar a ser gerado. Nenhum dos dois lê a saída do outro.
 *
 * ═══ POR QUE ESTE TESTE LÊ O FONTE, e não observa a chamada ═══
 *
 * Porque hoje não existe outro jeito, e isso está escrito no repositório:
 * `tests/invariants/case-reply-turn.test.ts` diz, no próprio cabeçalho, que o
 * núcleo do `inbound-turn` "é mockado — não existe seam de harness pra rodar o
 * núcleo". Todo teste que encosta no turno mocka `runAgentTurn` inteiro, então
 * não há ponto de observação onde a sobreposição das duas chamadas apareça.
 *
 * A doutrina do repo — presença de símbolo não é comportamento — continua
 * valendo, e é por isso que este arquivo NÃO afirma "está rápido": ele afirma
 * a única coisa que consegue verificar, que é a propriedade ESTRUTURAL de que
 * as duas chamadas partem do mesmo `Promise.all`. É o mesmo desenho de
 * `cron-audita-so-quando-ha-efeito.test.ts`, que também varre AST porque a
 * política que ele guarda não tem observador barato.
 *
 * O dia em que existir harness para o núcleo, este teste deve ser trocado por
 * um que meça a sobreposição de verdade.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ARQUIVO = join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts");
const AUXILIARES = ["classifyStage", "classifyJailbreak"] as const;

/** Nomes de função chamados em qualquer profundidade dentro de um nó. */
function chamadasDentro(no: ts.Node): Set<string> {
  const nomes = new Set<string>();
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) nomes.add(n.expression.text);
    ts.forEachChild(n, visitar);
  };
  visitar(no);
  return nomes;
}

/** Todo `Promise.all(...)` do arquivo. */
function promiseAlls(fonte: ts.SourceFile): ts.CallExpression[] {
  const achados: ts.CallExpression[] = [];
  const visitar = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Promise" &&
      n.expression.name.text === "all"
    ) {
      achados.push(n);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(fonte);
  return achados;
}

describe("auxiliares do turno rodam juntos", () => {
  const texto = readFileSync(ARQUIVO, "utf8");
  const fonte = ts.createSourceFile(ARQUIVO, texto, ts.ScriptTarget.Latest, true);

  it("o arquivo realmente chama os dois auxiliares", () => {
    // Sem esta guarda, renomear qualquer um dos dois deixaria o teste abaixo
    // verde por vacuidade — nenhum `Promise.all` precisaria conter nada.
    const todas = chamadasDentro(fonte);
    for (const aux of AUXILIARES) {
      expect(todas.has(aux), `${aux} não é mais chamado em inbound-turn.ts`).toBe(true);
    }
  });

  it("os dois partem do MESMO Promise.all", () => {
    const juntos = promiseAlls(fonte).filter((p) => {
      const dentro = chamadasDentro(p);
      return AUXILIARES.every((aux) => dentro.has(aux));
    });

    expect(
      juntos.length,
      "classifyStage e classifyJailbreak precisam sair do mesmo Promise.all — " +
        "em sequência, o cliente espera a SOMA dos dois (medido: 3,3s + 3,9s) " +
        "antes de o turno começar",
    ).toBe(1);
  });

  it("nenhum dos dois é aguardado sozinho fora desse Promise.all", () => {
    // O modo de falha real não é apagar o `Promise.all` — é alguém acrescentar
    // um `await classifyJailbreak(...)` antes dele "só para checar uma coisa",
    // e a serialização voltar com o paralelo ainda no lugar, verde.
    const paralelos = promiseAlls(fonte);
    const dentroDeParalelo = (n: ts.Node): boolean =>
      paralelos.some((p) => p.getStart() <= n.getStart() && n.getEnd() <= p.getEnd());

    const soltos: string[] = [];
    const visitar = (n: ts.Node): void => {
      if (
        ts.isAwaitExpression(n) &&
        ts.isCallExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        (AUXILIARES as readonly string[]).includes(n.expression.expression.text) &&
        !dentroDeParalelo(n)
      ) {
        soltos.push(n.expression.expression.text);
      }
      ts.forEachChild(n, visitar);
    };
    visitar(fonte);

    expect(soltos, `aguardado(s) em sequência, fora do Promise.all: ${soltos.join(", ")}`).toEqual([]);
  });
});
