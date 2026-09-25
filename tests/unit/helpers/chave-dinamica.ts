/**
 * A CHAVE QUE NÃO É LITERAL — e como ela é lida do código.
 *
 * ─── Por que esta varredura existe, separada da de literais ────────────────
 *
 * `t("Salvar")` é fácil: o texto está no AST, e o guardião de i18n o cobra
 * desde sempre. `t(ROTULOS[tipo])` não é: o que chega à tela depende do
 * `tipo`, e o AST não tem a string em lugar nenhum. Uma tabela inteira pode
 * estar sem tradução com o teste verde — foi assim que 124 strings do
 * catálogo de capacidades do agente de IA passaram batido (issue #603, achado
 * do @JowaniOrantes no PR #600).
 *
 * Esta varredura responde a pergunta certa: para cada `t(expr)` cujo argumento
 * NÃO é literal, **quais valores ele pode assumir**, e de onde eles vêm.
 *
 * ─── O que ela resolve, e o que ela NÃO resolve ────────────────────────────
 *
 * Resolve, porque o valor está escrito no módulo e não muda em execução:
 *
 *   - `t(ROTULO)` com `const ROTULO = "Salvar"` no topo do módulo;
 *   - `t(ROTULOS[k])`, `t(ROTULOS.tipo)`, `t(ROTULOS["tipo"])` com `const
 *     ROTULOS = { ... }` / `[...]` (inclusive `as const` e `satisfies`);
 *   - os mesmos três casos quando a constante mora em OUTRO módulo e chega
 *     por `import { ROTULOS } from "@/lib/..."` (caso nomeado, default ou
 *     `import * as`);
 *   - `t(r)` dentro de `Object.entries(ROTULOS).map(([k, r]) => …)` ou de
 *     `Object.values(ROTULOS).map((r) => …)` — o parâmetro só assume os valores
 *     da tabela (também `flatMap` e `forEach`).
 *
 * NÃO resolve, e é de propósito — cada um destes exigiria inferência de tipo
 * ou execução, e um gate que chuta é um gate que reprova sem defeito:
 *
 *   - constante declarada dentro de função (`const rotulo = cond ? "A" : "B"`
 *     depois de um `if`), porque o valor depende do caminho;
 *   - o que vem de parâmetro, `props`, campo de query, `err.message` — isto é
 *     dado de runtime, e quem o vigia é o passo 2 da issue #603 (proibir `t()`
 *     sobre origem não-constante);
 *   - template com interpolação (`` t(`Olá ${nome}`) ``);
 *   - tabela montada por função (`Object.fromEntries`, `.map`).
 *
 * Um sítio não resolvido NÃO é um sítio aprovado: ele é contado à parte
 * (`naoResolvidos`) justamente para que ninguém leia a ausência dele no
 * relatório como "está tudo traduzido".
 *
 * ─── Por que a varredura é COMPARTILHADA com as fixtures ───────────────────
 *
 * `tests/unit/i18n-espanhol-cobre-a-tela.test.ts` cobra o repositório com
 * esta função, e o mesmo arquivo roda a função contra
 * `tests/fixtures/catraca-do-espanhol/` — um caso verde e um vermelho, este
 * último com o valor que falta ao dicionário. Sem isso não haveria como saber
 * se o gate tem dente: varredura quebrada devolve lista vazia, e lista vazia
 * é indistinguível de "está tudo traduzido" (é a mesma armadilha que
 * `helpers/varrer-codigo.ts` documenta).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { arquivosDeCodigo, RAIZ_DO_REPO, caminhoRelativo } from "./varrer-codigo";

/** Um `t(expr)` cujo argumento não é literal, com os valores que ele pode assumir. */
export interface SitioDeChaveDinamica {
  /** Caminho relativo à raiz, em barra normal. */
  readonly arquivo: string;
  /** 1-based. */
  readonly linha: number;
  /** `arquivo:linha` — é assim que a mensagem de falha aponta o conserto. */
  readonly local: string;
  /** O texto da expressão como está no código (`ROTULOS[tipo]`). */
  readonly expressao: string;
  /** `t` ou `traduzir`; os dois são cobrados. */
  readonly chamada: string;
  /** De onde saiu a lista de valores, para quem for conferir (`const ROTULOS em lib/x.ts`). */
  readonly procedencia: string;
  /** Cada valor possível — a mesma chave que o dicionário precisa ter. */
  readonly valores: readonly string[];
}

/** Um `t(expr)` que esta varredura NÃO conseguiu resolver, só para relatório. */
export interface SitioNaoResolvido {
  readonly local: string;
  readonly expressao: string;
}

export interface VarreduraDeChaves {
  /** Chave literal (ou valor resolvido de chave dinâmica) → locais onde aparece. */
  readonly chaves: Map<string, string[]>;
  /** Só os sítios dinâmicos, com a procedência — é o que a catraca da #603 cobra. */
  readonly dinamicos: SitioDeChaveDinamica[];
  /** Sítios dinâmicos fora do alcance desta varredura (ver o cabeçalho). */
  readonly naoResolvidos: SitioNaoResolvido[];
  /** Quantos arquivos foram de fato lidos — controle de não-vacuidade. */
  readonly arquivosVarridos: number;
}

/** As áreas de código de PRODUÇÃO que renderizam tela ou frase de tela. */
export const AREAS_DE_PRODUTO = ["app", "components", "hooks", "lib"] as const;

/** Onde as fixtures ficam. Fora da varredura do repositório; só o teste de dente as lê. */
const DIRETORIO_DE_FIXTURES = "tests/fixtures";

function arquivoExiste(caminho: string): boolean {
  return existsSync(caminho) && !caminho.includes("node_modules");
}

/**
 * Desembrulha o que não muda o valor: `as const`, `satisfies X`, parênteses e
 * `as Tipo`. Sem isto, `const TABELA = {...} as const` — o padrão de tabela
 * fechada deste repo — apareceria como "não é literal" e a tabela inteira
 * ficaria invisível.
 */
function desembrulhar(expr: ts.Expression): ts.Expression {
  let no = expr;
  while (
    ts.isAsExpression(no) ||
    ts.isSatisfiesExpression(no) ||
    ts.isParenthesizedExpression(no) ||
    ts.isTypeAssertionExpression(no)
  ) {
    no = no.expression;
  }
  return no;
}

/**
 * Todo valor possível de uma expressão, ou `null` quando o valor não está
 * escrito no código. Objeto e array entram RECURSIVAMENTE: uma tabela de
 * rótulos aninhada (`{ eixo: { curto: "Curto" } }`) tem cada folha como um
 * valor possível, e a versão de um nível só a deixava passar.
 */
function valoresDe(expr: ts.Expression): string[] | null {
  const no = desembrulhar(expr);
  if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) return [no.text];
  const valores: string[] = [];
  const coletar = (n: ts.Expression): number => {
    const folha = desembrulhar(n);
    if (ts.isStringLiteral(folha) || ts.isNoSubstitutionTemplateLiteral(folha)) {
      valores.push(folha.text);
      return 1;
    }
    let achados = 0;
    if (ts.isObjectLiteralExpression(folha)) {
      for (const p of folha.properties) {
        if (ts.isPropertyAssignment(p)) achados += coletar(p.initializer);
        // spread e métodos ficam de fora: o valor deles não está escrito aqui.
      }
    } else if (ts.isArrayLiteralExpression(folha)) {
      for (const el of folha.elements) achados += coletar(el);
    }
    return achados;
  };
  if (ts.isObjectLiteralExpression(no) || ts.isArrayLiteralExpression(no)) {
    return coletar(no) > 0 ? valores : null;
  }
  return null;
}

/** Caminho absoluto de um módulo importado, ou `null` se não for fonte deste repo. */
function caminhoDoModulo(especificador: string, arquivoDeOrigem: string): string | null {
  let base: string;
  if (especificador.startsWith("@/")) base = path.join(RAIZ_DO_REPO, especificador.slice(2));
  else if (especificador.startsWith("."))
    base = path.resolve(path.dirname(arquivoDeOrigem), especificador);
  else return null; // pacote do npm: não é fonte deste repo.
  for (const candidato of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (arquivoExiste(candidato)) return candidato;
  }
  return null;
}

interface FonteAnalisada {
  readonly fonte: ts.SourceFile;
  /** Nome local → inicializador da constante de TOPO do módulo (`const`). */
  readonly constantes: Map<string, ts.Expression>;
  /** Nome local → módulo de onde ele veio por import. */
  readonly importados: Map<string, { arquivo: string; exportado: string }>;
  /** Nome local de um `import * as ns`. */
  readonly espacosDeNomes: Map<string, string>;
}

/**
 * Lê o módulo uma vez e indexa o que pode ser resolvido de forma estática.
 *
 * Só `const` de topo: `let` no topo é mutável, e uma tabela que alguém
 * reatribui em runtime não é uma constante — cobrar os valores dela seria
 * cobrar valores que o código pode nunca usar.
 */
function analisar(arquivo: string): FonteAnalisada {
  const fonte = ts.createSourceFile(
    arquivo,
    readFileSync(arquivo, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const constantes = new Map<string, ts.Expression>();
  const importados = new Map<string, { arquivo: string; exportado: string }>();
  const espacosDeNomes = new Map<string, string>();

  for (const stmt of fonte.statements) {
    if (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer)
          constantes.set(decl.name.text, decl.initializer);
      }
      continue;
    }
    // `export default { ... }` — tabela única exportada como default.
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      constantes.set("default", stmt.expression);
      continue;
    }
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const destino = caminhoDoModulo(stmt.moduleSpecifier.text, arquivo);
    if (!destino) continue;
    const clausula = stmt.importClause;
    if (!clausula) continue;
    if (clausula.name)
      importados.set(clausula.name.text, { arquivo: destino, exportado: "default" });
    const ligacoes = clausula.namedBindings;
    if (ligacoes && ts.isNamespaceImport(ligacoes)) {
      espacosDeNomes.set(ligacoes.name.text, destino);
    } else if (ligacoes && ts.isNamedImports(ligacoes)) {
      for (const el of ligacoes.elements) {
        importados.set(el.name.text, {
          arquivo: destino,
          exportado: el.propertyName?.text ?? el.name.text,
        });
      }
    }
  }
  return { fonte, constantes, importados, espacosDeNomes };
}

/** Cache de módulos por arquivo: `lib/` é importado por dezenas de telas. */
type CacheDeFontes = Map<string, FonteAnalisada | null>;

function lerModulo(arquivo: string, cache: CacheDeFontes): FonteAnalisada | null {
  if (cache.has(arquivo)) return cache.get(arquivo) ?? null;
  const analisado = arquivoExiste(arquivo) ? analisar(arquivo) : null;
  cache.set(arquivo, analisado);
  return analisado;
}

interface ValoresResolvidos {
  readonly valores: string[];
  readonly procedencia: string;
}

const METODOS_DE_ITERACAO = new Set(["map", "flatMap", "forEach"]);

/**
 * `r` em `Object.entries(TABELA).map(([k, r]) => t(r))` (segundo elemento) ou em
 * `Object.values(TABELA).map((r) => t(r))` (o próprio parâmetro): os únicos
 * valores possíveis são os da tabela. Qualquer outra forma devolve `null` — a
 * varredura não chuta.
 */
function resolverParametroDeIteracao(
  no: ts.Identifier,
  dono: FonteAnalisada,
  cache: CacheDeFontes,
): ValoresResolvidos | null {
  for (let n: ts.Node | undefined = no.parent; n; n = n.parent) {
    if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) continue;
    const parametro = n.parameters[0];
    if (!parametro) return null;
    let origem: "entries" | "values" | null = null;
    if (ts.isIdentifier(parametro.name) && parametro.name.text === no.text) {
      origem = "values";
    } else if (
      ts.isArrayBindingPattern(parametro.name) &&
      parametro.name.elements[1] &&
      ts.isBindingElement(parametro.name.elements[1]) &&
      ts.isIdentifier(parametro.name.elements[1].name) &&
      parametro.name.elements[1].name.text === no.text
    ) {
      origem = "entries";
    }
    if (!origem) continue; // o nome pertence a uma função mais externa: sobe.

    const chamada = n.parent;
    if (!ts.isCallExpression(chamada) || chamada.arguments[0] !== n) return null;
    const metodo = chamada.expression;
    if (!ts.isPropertyAccessExpression(metodo) || !METODOS_DE_ITERACAO.has(metodo.name.text)) {
      return null;
    }
    const fonteDaLista = desembrulhar(metodo.expression);
    if (!ts.isCallExpression(fonteDaLista) || fonteDaLista.arguments.length !== 1) return null;
    const construtor = fonteDaLista.expression;
    if (
      !ts.isPropertyAccessExpression(construtor) ||
      !ts.isIdentifier(construtor.expression) ||
      construtor.expression.text !== "Object" ||
      construtor.name.text !== origem
    ) {
      return null;
    }
    const alvo = fonteDaLista.arguments[0];
    if (!alvo) return null;
    const base = baseDeExpressao(desembrulhar(alvo), dono, cache);
    const valores = base ? valoresDe(base.inicializador) : null;
    if (!base || !valores) return null;
    return { valores, procedencia: `${base.procedencia} (Object.${origem}().${metodo.name.text})` };
  }
  return null;
}

/**
 * O coração: dado o argumento de `t()`, devolve os valores possíveis e a
 * procedência escrita, ou `null` se o valor não estiver no código.
 */
function resolver(
  arg: ts.Expression,
  dono: FonteAnalisada,
  cache: CacheDeFontes,
  profundidade = 0,
): ValoresResolvidos | null {
  if (profundidade > 4) return null; // tabela que se referencia em ciclo: para aqui.
  const no = desembrulhar(arg);

  // `t(a ? "A" : "B")`: os dois ramos são valores possíveis, e os dois são
  // estáticos. Um ternário sobre dado de runtime cai no `null` do ramo.
  if (ts.isConditionalExpression(no)) {
    const sim = resolver(no.whenTrue, dono, cache, profundidade + 1);
    const nao = resolver(no.whenFalse, dono, cache, profundidade + 1);
    if (!sim && !nao) return null;
    if (!sim) return nao;
    if (!nao) return sim;
    return {
      valores: [...sim.valores, ...nao.valores],
      procedencia: `${sim.procedencia} e ${nao.procedencia}`,
    };
  }

  // `TABELA[k] ?? "Sem rótulo"` NÃO entra: medido na `main` de 18/08/2026, os 79
  // sítios com `??`/`||` deste repositório têm um lado vindo de dado de runtime
  // (`RÓTULOS[tipo] ?? tipo`). Cobrar o conjunto "real" ali exigiria análise de
  // fluxo de dado de operador — que é o passo 2 da issue, não este. Chutar a
  // interseção aqui faria a catraca cobrar valores que não são os que a tela
  // mostra, e falso positivo em catraca nova custa a confiança dela.

  // `t(r)` dentro de `Object.entries(TABELA).map(([k, r]) => …)` ou de
  // `Object.values(TABELA).map((r) => …)`: o parâmetro só pode assumir os valores
  // da tabela, e eles estão escritos no módulo.
  if (ts.isIdentifier(no)) {
    const viaTabela = resolverParametroDeIteracao(no, dono, cache);
    if (viaTabela) return viaTabela;
  }

  // `ROTULOS.tipo` / `ns.TABELA.tipo` — valor exato da propriedade quando o
  // nome é literal; a tabela inteira não serve aqui, porque só um rótulo é usado.
  if (ts.isPropertyAccessExpression(no) || ts.isElementAccessExpression(no)) {
    const exato = acessoEstatico(no, dono, cache);
    if (exato) return exato;
  }

  if (ts.isPropertyAccessExpression(no) || ts.isElementAccessExpression(no)) {
    // Índice de runtime (`TABELA[chave]`, `TABELA[campo.tipo]`): qualquer valor
    // da tabela pode chegar à tela, então TODOS são cobrados. O alvo sai de
    // `no.expression` — `X[k]` cobra `X`, e `ns.X[k]` cobra `ns.X`.
    const base = baseDeExpressao(no.expression, dono, cache);
    if (!base) return null;
    const valores = valoresDe(base.inicializador);
    if (!valores) return null;
    return { valores, procedencia: `${base.procedencia} (acesso por índice)` };
  }

  const base = baseDe(no, dono, cache);
  if (!base) return null;

  const valores = valoresDe(base.inicializador);
  if (!valores) return null;
  return { valores, procedencia: base.procedencia };
}

/**
 * O alvo de um acesso: `X` (const do módulo, própria ou importada) ou
 * `ns.X` (tabela de um `import * as ns`).
 */
function baseDeExpressao(
  alvo: ts.Expression,
  dono: FonteAnalisada,
  cache: CacheDeFontes,
): { inicializador: ts.Expression; procedencia: string } | null {
  if (ts.isIdentifier(alvo)) return baseDe(alvo, dono, cache);
  if (ts.isPropertyAccessExpression(alvo) && ts.isIdentifier(alvo.expression)) {
    const modulo = dono.espacosDeNomes.get(alvo.expression.text);
    const moduloLido = modulo ? lerModulo(modulo, cache) : null;
    const tabela = moduloLido?.constantes.get(alvo.name.text);
    if (moduloLido && tabela) {
      return {
        inicializador: tabela,
        procedencia: `const ${alvo.name.text} em ${caminhoRelativo(modulo ?? "")} (importado como ${alvo.expression.text})`,
      };
    }
  }
  return null;
}

/** Onde o valor está escrito: `const X` do módulo, ou `X` importado de outro módulo. */
function baseDe(
  no: ts.Expression,
  dono: FonteAnalisada,
  cache?: CacheDeFontes,
): { inicializador: ts.Expression; procedencia: string } | null {
  if (!ts.isIdentifier(no)) return null;
  const local = dono.constantes.get(no.text);
  if (local) return { inicializador: local, procedencia: `const ${no.text} no próprio arquivo` };
  const importado = dono.importados.get(no.text);
  if (importado && cache) {
    const modulo = lerModulo(importado.arquivo, cache);
    const destino = modulo?.constantes.get(importado.exportado);
    if (modulo && destino) {
      const onde = caminhoRelativo(importado.arquivo);
      const nome =
        importado.exportado === "default"
          ? `default de ${onde}`
          : `${importado.exportado} em ${onde}`;
      return { inicializador: destino, procedencia: `const ${nome} (importado como ${no.text})` };
    }
  }
  return null;
}

/** `TABELA.tipo` / `TABELA["tipo"]` — a folha exata, quando o nome da chave é literal. */
function acessoEstatico(
  no: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  dono: FonteAnalisada,
  cache: CacheDeFontes,
): ValoresResolvidos | null {
  const nome = ts.isPropertyAccessExpression(no)
    ? no.name.text
    : ts.isStringLiteral(no.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(no.argumentExpression)
      ? no.argumentExpression.text
      : ts.isIdentifier(no.argumentExpression)
        ? null // `TABELA[chave]`: índice de runtime, tratado como tabela inteira.
        : null;
  if (!nome) return null;

  // O alvo pode ser `TABELA`, mas também `ns.TABELA` (import * as).
  const alvo: ts.Expression = no.expression;
  if (ts.isPropertyAccessExpression(alvo) && ts.isIdentifier(alvo.expression)) {
    const modulo = dono.espacosDeNomes.get(alvo.expression.text);
    const moduloLido = modulo ? lerModulo(modulo, cache) : null;
    const tabela = moduloLido?.constantes.get(alvo.name.text);
    if (moduloLido && tabela) {
      const folha = folhaDe(tabela, nome);
      if (folha)
        return {
          valores: folha,
          procedencia: `const ${alvo.name.text} em ${caminhoRelativo(modulo ?? "")} (importado como ${alvo.expression.text})`,
        };
      return null;
    }
  }
  const base = baseDe(alvo, dono, cache);
  if (!base) return null;
  const folha = folhaDe(base.inicializador, nome);
  if (!folha) return null;
  return { valores: folha, procedencia: `${base.procedencia}, campo "${nome}"` };
}

/**
 * `folhaDe` lê estrutura LITERAL (`{ tipo: "Rótulo" }`) e não desce módulo
 * nenhum, então não recebe `profundidade`: quem corta ciclo entre módulos é o
 * `cache` (`CacheDeFontes` guarda `null` para o que não achou).
 */
function folhaDe(inicializador: ts.Expression, nome: string): string[] | null {
  const alvo = desembrulhar(inicializador);
  if (ts.isObjectLiteralExpression(alvo)) {
    for (const p of alvo.properties) {
      if (ts.isPropertyAssignment(p)) {
        const chave = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
        if (chave === nome) return valoresDe(p.initializer);
      }
    }
    return null;
  }
  return null;
}

/**
 * Varre as raízes pedidas e devolve o que `t()` recebe: as chaves literais, os
 * sítios de chave dinâmica com seus valores possíveis, e o que ficou fora do
 * alcance. As raízes são caminhos RELATIVOS à raiz do repo, como em
 * `arquivosDeCodigo`.
 */
export function varrerChavesDeI18n(raizes: readonly string[]): VarreduraDeChaves {
  const chaves = new Map<string, string[]>();
  const dinamicos: SitioDeChaveDinamica[] = [];
  const naoResolvidos: SitioNaoResolvido[] = [];
  const cache: CacheDeFontes = new Map();
  let arquivosVarridos = 0;

  for (const arquivo of arquivosDeCodigo(raizes)) {
    const rel = caminhoRelativo(arquivo);
    // O dicionário declara as chaves; a função que as traduz não as usa.
    if (rel === "lib/i18n/dicionario.ts") continue;
    const src = readFileSync(arquivo, "utf8");
    if (!/\bt\(|\btraduzir\(/.test(src)) continue;
    arquivosVarridos++;
    const dono = analisar(arquivo);
    const registra = (texto: string, no: ts.Node) => {
      const linha = dono.fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1;
      chaves.set(texto, [...(chaves.get(texto) ?? []), `${rel}:${linha}`]);
    };

    const visita = (no: ts.Node): void => {
      if (ts.isCallExpression(no) && no.arguments.length > 0) {
        const alvo = no.expression;
        const chamada = ts.isIdentifier(alvo)
          ? alvo.text
          : ts.isPropertyAccessExpression(alvo)
            ? alvo.name.text
            : "";
        const arg = no.arguments[0];
        if ((chamada === "t" || chamada === "traduzir") && arg) {
          const linha = dono.fonte.getLineAndCharacterOfPosition(arg.getStart()).line + 1;
          if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            registra(arg.text, arg);
          } else {
            const resolvido = resolver(arg, dono, cache);
            const expressao = arg.getText(dono.fonte);
            if (resolvido && resolvido.valores.length > 0) {
              for (const v of resolvido.valores) registra(v, arg);
              dinamicos.push({
                arquivo: rel,
                linha,
                local: `${rel}:${linha}`,
                expressao,
                chamada,
                procedencia: resolvido.procedencia,
                valores: [...new Set(resolvido.valores)],
              });
            } else {
              naoResolvidos.push({ local: `${rel}:${linha}`, expressao });
            }
          }
        }
      }
      ts.forEachChild(no, visita);
    };
    visita(dono.fonte);
  }

  return { chaves, dinamicos, naoResolvidos, arquivosVarridos };
}

/** Diretório das fixtures da catraca — exposto para o teste de dente não repetir o caminho. */
export const RAIZ_DAS_FIXTURES = `${DIRETORIO_DE_FIXTURES}/catraca-do-espanhol`;

/** Uma chave que a catraca cobra e o dicionário não tem em espanhol. */
export interface BuracoDeEspanhol {
  readonly arquivo: string;
  readonly chave: string;
  /** `arquivo:linha` de CADA chamada que passa esse valor a `t()` / `traduzir()`. */
  readonly locais: string[];
  /** A expressão resolvida e de onde ela veio — o que quem for consertar precisa ver. */
  readonly procedencia: string;
}

/**
 * Cruza os valores possíveis das chaves dinâmicas com o dicionário.
 *
 * O buraco é um par (arquivo, valor), não um valor solto: a dívida congelada é
 * um buraco num lugar específico, então mover a chamada de arquivo faz a entrada
 * da allowlist deixar de casar e a catraca obriga a olhar de novo. Casar por
 * `arquivo:linha` seria pior — rebase alheio que sobe três linhas pintaria
 * vermelho sem ninguém ter mexido em tradução.
 *
 * `temEspanhol` é injetado (e não o dicionário real) para a fixture poder provar
 * o dente do lado de fora do produto.
 */
export function buracosDeEspanhol(
  varredura: VarreduraDeChaves,
  temEspanhol: (chave: string) => boolean,
): BuracoDeEspanhol[] {
  const buracos = new Map<
    string,
    { arquivo: string; chave: string; locais: string[]; procedencia: string }
  >();
  for (const sitio of varredura.dinamicos) {
    for (const chave of sitio.valores) {
      if (temEspanhol(chave)) continue;
      const id = `${sitio.arquivo}\u0000${chave}`;
      const existente = buracos.get(id);
      if (existente) {
        existente.locais.push(sitio.local);
        continue;
      }
      buracos.set(id, {
        arquivo: sitio.arquivo,
        chave,
        locais: [sitio.local],
        procedencia: `${sitio.expressao} — ${sitio.procedencia}`,
      });
    }
  }
  return [...buracos.values()].map((b) => ({ ...b, locais: [...b.locais].sort() }));
}
