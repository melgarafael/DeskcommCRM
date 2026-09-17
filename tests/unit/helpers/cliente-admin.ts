/**
 * CLIENTE DE SERVIÇO — a maquinaria de varredura, num lugar só.
 *
 * Dois testes fazem perguntas diferentes sobre o MESMO fato: "de onde veio este
 * cliente?" (`escrita-em-organizations-usa-cliente-admin`, que cobra o cliente
 * admin em `organizations`) e "esta cadeia filtra o tenant?"
 * (`admin-client-exige-filtro-de-tenant`, que cobra o filtro no caminho que a
 * RLS NÃO vê). Os dois precisam da mesma coisa: resolver o identificador-raiz de
 * uma cadeia `x.from(...).eq(...)` e saber quais nomes, NAQUELE arquivo, vieram
 * de `createAdminClient()`.
 *
 * Resolver o identificador é o ponto, e não um detalhe de estilo: procurar a
 * string "createAdminClient" no arquivo inteiro daria verde para um handler que
 * tem o cliente admin numa função e o de sessão na outra — a forma exata do
 * defeito que os dois medem.
 */
import ts from "typescript";

/**
 * O identificador-raiz de uma cadeia `x.from(...).eq(...)`; `null` quando a raiz
 * não é um nome (ex.: índice de array, chamada de outra coisa).
 *
 * `createAdminClient().from(...)` devolve `"createAdminClient"`: a fábrica
 * inline, sem variável pelo caminho.
 */
export function raizDaCadeia(no: ts.Expression): string | null {
  let atual: ts.Node = no;
  while (true) {
    if (ts.isIdentifier(atual)) return atual.text;
    if (ts.isCallExpression(atual)) {
      atual = atual.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(atual)) {
      atual = atual.expression;
      continue;
    }
    if (ts.isAwaitExpression(atual) || ts.isParenthesizedExpression(atual)) {
      atual = atual.expression;
      continue;
    }
    return null;
  }
}

/**
 * Os nomes que, NAQUELE arquivo, foram declarados a partir de
 * `createAdminClient()` — `const admin = await createAdminClient()`.
 */
export function nomesDoClienteAdmin(fonte: ts.SourceFile): Set<string> {
  const nomes = new Set<string>();
  const visitar = (no: ts.Node): void => {
    if (ts.isVariableDeclaration(no) && no.initializer && ts.isIdentifier(no.name)) {
      let init: ts.Node = no.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === "createAdminClient"
      ) {
        nomes.add(no.name.text);
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return nomes;
}

/**
 * True quando a raiz da cadeia é cliente de SERVIÇO: nome declarado de
 * `createAdminClient()` naquele arquivo, ou a própria fábrica inline.
 *
 * O que fica de fora, de propósito: cliente admin recebido por PARÂMETRO
 * (o caminho de `lib/mcp/server.ts`, que entrega o cliente de serviço ao
 * handler). Atravessar arquivos é outra varredura — e está declarado no
 * docstring do teste que usa isto.
 */
export function ehClienteDeServico(raiz: ts.Expression, admins: ReadonlySet<string>): boolean {
  const nome = raizDaCadeia(raiz);
  if (nome === null) return false;
  return nome === "createAdminClient" || admins.has(nome);
}

/** Um passo da cadeia: o método chamado e a chamada que o aplica. */
export interface PassoDaCadeia {
  readonly metodo: string;
  readonly chamada: ts.CallExpression;
}

/**
 * Os passos `.metodo(...)` que CONTINUAM a cadeia a partir de `chamada`, de
 * dentro para fora: em `x.from("t").select("a").eq("b", c)`, a partir do
 * `from` devolve `select` e depois `eq`.
 *
 * Exige que a fonte tenha sido criada com `setParentNodes = true`.
 */
export function passosDaCadeia(chamada: ts.CallExpression): PassoDaCadeia[] {
  const passos: PassoDaCadeia[] = [];
  let atual: ts.Node = chamada;
  for (;;) {
    const acesso = atual.parent;
    if (acesso === undefined || !ts.isPropertyAccessExpression(acesso) || acesso.expression !== atual) {
      break;
    }
    const proxima = acesso.parent;
    if (proxima === undefined || !ts.isCallExpression(proxima) || proxima.expression !== acesso) {
      break;
    }
    passos.push({ metodo: acesso.name.text, chamada: proxima });
    atual = proxima;
  }
  return passos;
}
