/**
 * QUEM ESCREVE EM `organizations` PRECISA DO CLIENTE ADMIN — E O PORQUÊ É UMA FALHA SILENCIOSA.
 *
 * A RLS de `organizations` deixa o membro LER a própria organização e deixa
 * ESCREVER só quem é platform admin. Com o cliente de sessão, um
 * `update(...).eq("id", orgId)` feito pelo `admin` do próprio tenant casa ZERO
 * linhas — e o PostgREST devolve **sucesso**, sem erro. A tela diz "salvo" e
 * nada foi gravado.
 *
 * ═══ POR QUE ISTO PRECISA DE UM GATE, E NÃO DE UMA LINHA NA DOUTRINA ═══
 *
 * O modo de falha é invisível de três maneiras ao mesmo tempo:
 *
 * 1. **Não dá erro.** Nenhum `catch` acende, nenhum Sentry abre.
 * 2. **Funciona na máquina de quem escreveu.** O `install.sh` cria o dono da
 *    instalação COMO platform admin — então o autor testa, grava, e só o
 *    SEGUNDO administrador do time descobre. Num produto self-host, isso
 *    significa que o defeito viaja até o cliente.
 * 3. **Os testes de rota não podem vê-lo.** Eles mockam `createClient` inteiro
 *    com um stub que sempre dá certo; um teste de unidade não tem RLS.
 *
 * A regra não está no `CLAUDE.md` — ela vive só como padrão nos arquivos
 * irmãos, e um contribuidor que siga o `createClient()` do resto do handler
 * acerta tudo que os gates visíveis sabem cobrar e ainda assim entrega um
 * controle decorativo. Aconteceu no PR #671, e é por isso que este arquivo
 * existe: `lib/ai/pontos` não tinha como saber.
 *
 * ═══ O QUE ESTE GATE NÃO DIZ ═══
 *
 * Ele não afere que o `.eq("organization_id", …)` / `.eq("id", …)` está lá — o
 * cliente admin passa por cima da RLS, e o filtro de tenant vira
 * responsabilidade do arquivo (anti-pattern 10 do `CLAUDE.md`). Isso é matéria
 * de revisão humana. Aqui a pergunta é só: a escrita tem chance de acontecer?
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const RAIZES = ["app", "lib", "workers"] as const;
const MUTACOES = new Set(["update", "insert", "upsert", "delete"]);

/**
 * Arquivos liberados, com o motivo escrito. Esta lista só encolhe: quem
 * acrescentar um nome aqui está dizendo que a escrita não passa pela RLS de
 * `organizations` por um motivo que sobrevive à leitura de outra pessoa.
 */
const LIBERADOS = new Map<string, string>([
  [
    "lib/auth/provision.ts",
    "cria a organização no provisionamento, antes de existir membro — não há " +
      "sessão de tenant para a RLS avaliar, e o cliente já é o de serviço.",
  ],
]);

interface Achado {
  arquivo: string;
  linha: number;
  cliente: string;
  metodo: string;
}

/** O identificador-raiz de uma cadeia `x.from(...).update(...)`. */
function raizDaCadeia(no: ts.Expression): string | null {
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
 * `createAdminClient()`. Resolver o identificador é o ponto: procurar a string
 * "createAdminClient" no arquivo inteiro daria verde para um handler que tem o
 * cliente admin numa função e o de sessão na outra — que é exatamente a forma
 * do PR #671.
 */
function nomesDoClienteAdmin(fonte: ts.SourceFile): Set<string> {
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

function escritasEmOrganizations(caminho: string): Achado[] {
  const texto = readFileSync(caminho, "utf8");
  if (!texto.includes('from("organizations")')) return [];

  const fonte = ts.createSourceFile(caminho, texto, ts.ScriptTarget.Latest, true);
  const admins = nomesDoClienteAdmin(fonte);
  const achados: Achado[] = [];

  const visitar = (no: ts.Node): void => {
    // `<cadeia>.<mutacao>(...)` onde a cadeia contém `.from("organizations")`.
    if (
      ts.isCallExpression(no) &&
      ts.isPropertyAccessExpression(no.expression) &&
      MUTACOES.has(no.expression.name.text)
    ) {
      const alvo = no.expression.expression;
      // `arguments[0]` sai do índice como `Expression | undefined` sob
      // `noUncheckedIndexedAccess`, e o `length === 1` do lado não estreita o
      // tipo — daí o `const` antes do guard, em vez do índice repetido.
      const argumentoDoFrom = ts.isCallExpression(alvo) ? alvo.arguments[0] : undefined;
      if (
        ts.isCallExpression(alvo) &&
        ts.isPropertyAccessExpression(alvo.expression) &&
        alvo.expression.name.text === "from" &&
        alvo.arguments.length === 1 &&
        argumentoDoFrom !== undefined &&
        ts.isStringLiteral(argumentoDoFrom) &&
        argumentoDoFrom.text === "organizations"
      ) {
        const raiz = raizDaCadeia(alvo.expression.expression);
        if (raiz !== null && !admins.has(raiz)) {
          achados.push({
            arquivo: caminhoRelativo(caminho),
            linha: fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1,
            cliente: raiz,
            metodo: no.expression.name.text,
          });
        }
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return achados;
}

const ARQUIVOS = arquivosDeCodigo(RAIZES);

describe("toda escrita em `organizations` passa pelo cliente admin", () => {
  it("CONTROLE: a varredura enxerga os arquivos que tocam a tabela", () => {
    expect(ARQUIVOS.length).toBeGreaterThan(500);
    const tocam = ARQUIVOS.filter((a) => readFileSync(a, "utf8").includes('from("organizations")'));
    expect(
      tocam.length,
      "zero arquivos tocando `organizations` é indistinguível de 'está tudo em ordem' — a sonda cegou",
    ).toBeGreaterThan(20);
  });

  it("CONTROLE: o resolvedor de identificador reconhece o padrão em vigor", () => {
    const gemeo = ARQUIVOS.find((a) => caminhoRelativo(a) === "app/actions/auth/politicaDeMfa.ts");
    expect(gemeo, "o gêmeo que escreve o MESMO jsonb sumiu — a sonda perdeu a referência").toBeDefined();
    expect(escritasEmOrganizations(gemeo as string)).toEqual([]);
  });

  it("nenhum arquivo escreve com o cliente de sessão", () => {
    const achados = ARQUIVOS.flatMap(escritasEmOrganizations).filter(
      (a) => !LIBERADOS.has(a.arquivo),
    );
    expect(
      achados,
      "Escrita em `organizations` com cliente de sessão. A RLS só deixa escrever " +
        "platform admin, então isto casa ZERO linhas e o PostgREST devolve SUCESSO — " +
        "a tela diz 'salvo' e nada foi gravado. Troque por `createAdminClient()` e " +
        "mantenha o filtro de tenant explícito (`.eq(\"id\", org.orgId)`), que com o " +
        "service role passa a ser responsabilidade deste arquivo.",
    ).toEqual([]);
  });

  it("a lista de liberados não tem nome órfão", () => {
    for (const arquivo of LIBERADOS.keys()) {
      const existe = ARQUIVOS.some((a) => caminhoRelativo(a) === arquivo);
      expect(existe, `\`${arquivo}\` está liberado e não existe mais — a lista só encolhe`).toBe(true);
    }
  });
});
