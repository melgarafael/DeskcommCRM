/**
 * OS DOIS CLASSIFICADORES AUXILIARES DO TURNO RODAM EM PARALELO.
 *
 * ## O que está preso aqui
 *
 * `classifyStage` (etapa do funil) e `classifyJailbreak` (anti-jailbreak) são
 * duas idas-e-voltas de LLM que o turno faz ANTES de responder ao cliente.
 * Nenhuma consome o resultado da outra. Em série, o cliente espera a SOMA das
 * duas; em `Promise.all`, só a mais lenta. A diferença é latência pura, paga em
 * todo turno de toda conversa — e ela volta sem ninguém perceber no dia em que
 * alguém, reorganizando o turno, trocar o `Promise.all` por dois `await`: o
 * comportamento visível continua certo, só mais lento.
 *
 * ## Por que por AST, e não executando o turno
 *
 * O call site mora em `executarTurnoDoAgente`, que não é exportada e precisa do
 * turno inteiro — o mesmo motivo registrado em `handoff-por-orcamento.test.ts`.
 * A propriedade é medida onde ela mora, com CONTROLE NEGATIVO obrigatório: um
 * detector quebrado deixaria este arquivo verde sem medir nada.
 *
 * A régua é estrutural e não textual: as duas chamadas precisam estar como
 * elementos do MESMO array passado a `Promise.all`. Contar `Promise.all(` no
 * texto, ou exigir que as duas apareçam "perto", aceitaria a regressão.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

const INBOUND = join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts");
/**
 * O Jev na camada anti-manipulação (`perguntarManipulacaoAoJev`) entra na lista:
 * ele é "latência adicional zero" só enquanto for elemento do MESMO array — o
 * turno espera o mais lento dos três, nunca a soma.
 */
const CLASSIFICADORES = ["classifyStage", "classifyJailbreak", "perguntarManipulacaoAoJev"] as const;

/**
 * Para cada chamada a um classificador, devolve o `Promise.all` que a contém
 * como elemento de array (direto ou por um ternário), ou `null` se ela é
 * esperada sozinha.
 *
 * Também vale a chamada guardada numa `const` que é elemento do array — é assim
 * que o turno segura a promessa do Jev para gravar o custo dele quando o teto de
 * gasto derruba o classificador de sempre (R8). A promessa já corre desde a
 * `const`, então só conta se NINGUÉM a espera antes do `Promise.all`: um
 * `await` dela antes é a mesma espera em série, com outro nome.
 */
function paralelismoDosClassificadores(texto: string) {
  const ast = ts.createSourceFile("inbound.ts", texto, ts.ScriptTarget.Latest, true);
  const achados: Array<{ nome: string; promiseAll: ts.CallExpression | null }> = [];

  const ePromiseAll = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === "Promise" &&
    n.expression.name.text === "all";

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (CLASSIFICADORES as readonly string[]).includes(node.expression.text)
    ) {
      // Sobe atravessando SÓ o que mantém a chamada como valor do elemento:
      // parênteses e ternário. Qualquer outra coisa (um `await`, uma função)
      // significa que a chamada não é elemento direto do array.
      let atual: ts.Node = node;
      while (
        atual.parent &&
        (ts.isParenthesizedExpression(atual.parent) || ts.isConditionalExpression(atual.parent))
      ) {
        atual = atual.parent;
      }
      const array = atual.parent;
      const chamada = array && ts.isArrayLiteralExpression(array) ? array.parent : undefined;
      const guardadaEm =
        ts.isVariableDeclaration(atual.parent) &&
        ts.isIdentifier(atual.parent.name) &&
        ts.isVariableDeclarationList(atual.parent.parent) &&
        (atual.parent.parent.flags & ts.NodeFlags.Const) !== 0
          ? atual.parent
          : null;
      achados.push({
        nome: node.expression.text,
        promiseAll:
          chamada && ePromiseAll(chamada)
            ? chamada
            : guardadaEm
              ? promiseAllDaConst((guardadaEm.name as ts.Identifier).text, guardadaEm.end)
              : null,
      });
    }
    ts.forEachChild(node, visit);
  };
  /** O `Promise.all` que recebe a `const` como elemento — `null` se ela é esperada antes dele. */
  function promiseAllDaConst(nome: string, desde: number): ts.CallExpression | null {
    let achado: ts.CallExpression | null = null;
    let esperadaAntes = false;
    const procurar = (n: ts.Node) => {
      if (ts.isIdentifier(n) && n.text === nome && n.pos >= desde) {
        const pai = n.parent;
        if (ts.isArrayLiteralExpression(pai) && ePromiseAll(pai.parent)) achado ??= pai.parent;
        // Em ordem de fonte: um `await` visto antes do array é espera em série.
        else if (ts.isAwaitExpression(pai) && achado === null) esperadaAntes = true;
      }
      ts.forEachChild(n, procurar);
    };
    procurar(ast);
    return esperadaAntes ? null : achado;
  }

  visit(ast);
  return achados;
}

describe("classificadores auxiliares do turno — em paralelo, nunca em série", () => {
  const fonte = readFileSync(INBOUND, "utf8");

  it("cada classificador é chamado exatamente uma vez no turno", () => {
    const achados = paralelismoDosClassificadores(fonte);
    expect(achados.map((a) => a.nome).sort()).toEqual([...CLASSIFICADORES].sort());
  });

  it("todos são elementos do MESMO Promise.all", () => {
    const achados = paralelismoDosClassificadores(fonte);
    expect(achados.every((a) => a.promiseAll !== null)).toBe(true);
    expect(new Set(achados.map((a) => a.promiseAll)).size).toBe(1);
  });

  it("controle negativo: esperar um deles sozinho é acusado", () => {
    // Tira o `classifyJailbreak` do array e o espera depois, em série — a
    // regressão exata que este arquivo existe para pegar.
    const sabotado = `${fonte}\nasync function emSerie() { await classifyJailbreak(a, b, c, d, e); }`;
    const achados = paralelismoDosClassificadores(sabotado);
    expect(achados.filter((a) => a.promiseAll === null).map((a) => a.nome)).toEqual([
      "classifyJailbreak",
    ]);
  });

  it("controle negativo: a promessa guardada numa const e esperada ANTES do Promise.all é acusada", () => {
    const ancora = "    const [stageResultado, jailbreakVerdict, manipulacaoDoJev] = await Promise.all([";
    const sabotado = fonte.replace(ancora, `    await perguntaAoJev;\n${ancora}`);
    expect(sabotado).not.toBe(fonte);
    const achados = paralelismoDosClassificadores(sabotado);
    expect(achados.filter((a) => a.promiseAll === null).map((a) => a.nome)).toEqual([
      "perguntarManipulacaoAoJev",
    ]);
  });

  it("controle negativo: dois Promise.all separados (um por classificador) são acusados", () => {
    const sabotado = fonte.replace(
      "const [stageResultado, jailbreakVerdict, manipulacaoDoJev] = await Promise.all([",
      "const [stageResultado] = await Promise.all([",
    );
    expect(sabotado).not.toBe(fonte);
    const separado = `${sabotado}\nasync function outro() { await Promise.all([classifyStage(a, b, c, d, e)]); }`;
    const achados = paralelismoDosClassificadores(separado);
    expect(new Set(achados.map((a) => a.promiseAll)).size).toBeGreaterThan(1);
  });
});
