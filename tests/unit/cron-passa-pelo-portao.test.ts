/**
 * A CERCA DO PORTÃO DO PISO OCIOSO: PASSO NOVO ABAIXO DELE TEM DE ESTAR DECLARADO.
 *
 * ─── O defeito, medido (issue #3773) ────────────────────────────────────────
 *
 * O portão do piso ocioso (#3731) é uma SAÍDA ANTECIPADA DA ROTA INTEIRA:
 *
 *     if (await recursoOcioso("<recurso>")) return ok({ pulado: "recurso_ocioso" });
 *
 * Tudo que está ABAIXO dessa linha roda só quando o recurso tem trabalho. Quem
 * acrescenta um passo ali — um aviso, uma promoção, um fechamento — ganha um
 * passo que NÃO roda na instalação ociosa, que é o caso comum: sem erro, sem
 * log, sem teste vermelho. O passo novo nasce desligado e ninguém fica sabendo.
 *
 * Não é hipótese. O #3650 (Spec 32) pôs três passos na `historico-import`
 * (abrir as recuperações das quedas do número, promover/cancelar as que
 * aguardam, fechar os avisos de cliente já respondido) e teve de ALARGAR o sinal
 * do portão para eles — porque estavam antes da rodada. Os mesmos três passos,
 * três linhas abaixo do `return`, teriam ficado mudos, e o sintoma apareceria
 * dias depois numa instalação que "não faz nada".
 *
 * ─── O desenho: cada rota declara os passos, o teste confere contra o arquivo ─
 *
 * Cada uma das cinco rotas com portão carrega uma constante local
 * `PASSOS_DEPOIS_DO_PORTAO` com os passos de NÍVEL SUPERIOR que rodam depois do
 * portão, na ordem do arquivo. Este teste lê o FONTE pelo AST, acha o `if` do
 * portão, acha a função que o contém e compara, índice por índice, o que está
 * de fato abaixo do portão com o que a rota declarou. Divergiu, reprova com
 * ARQUIVO e LINHA do passo infrator — é o vermelho que o defeito não dava.
 *
 * A declaração fica na rota, e não numa tabela aqui, de propósito: é onde quem
 * acrescenta o passo está olhando. Ao preencher a lista, a pessoa lê "este passo
 * está DEPOIS do portão" e decide com essa informação à vista — em vez de
 * descobrir o problema numa instalação ociosa.
 *
 * ─── Por que AST e não regex ────────────────────────────────────────────────
 *
 * A prosa deste repositório cita `recursoOcioso(` e `return ok({ pulado: ... })`
 * o tempo todo, inclusive no cabeçalho das próprias rotas. Um regex acusaria o
 * TEXTO que descreve a regra e ficaria cego para o código que a viola — o mesmo
 * motivo que já levou `cron-audita-so-quando-ha-efeito` ao AST.
 *
 * ─── O limite, declarado ────────────────────────────────────────────────────
 *
 * A lista é do NÍVEL SUPERIOR da função. Instrução acrescentada DENTRO de um
 * bloco que já existe (o corpo do `for` da `historico-import`, o `try` da
 * `prospecting`) não muda a lista e não reprova aqui. Isso é deliberado: código
 * aninhado já só roda quando o laço/condição que o contém teve trabalho, então
 * ele não é o passo que o portão desliga — mas é um buraco conhecido, e está
 * registrado no corpo do PR (#3773) como NÃO coberto.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const DIR_CRON = join(RAIZ, "app", "api", "v1", "cron");

/** O nome que cada rota usa para declarar; a cerca acha a constante pelo nome. */
const NOME_DA_DECLARACAO = "PASSOS_DEPOIS_DO_PORTAO";

/** As cinco rotas que têm o portão hoje (#3731). Rota nova com portão entra sozinha. */
const ROTAS_CONHECIDAS = [
  "agenda-google-push",
  "agenda-google-sync",
  "campaign-worker",
  "historico-import",
  "prospecting",
];

const AJUDA =
  "Um passo abaixo do portão roda SÓ quando o recurso tem trabalho: em instalação ociosa a rota " +
  "sai antes dele. Declare o passo em PASSOS_DEPOIS_DO_PORTAO (na própria rota) depois de decidir se " +
  "ele pode mesmo ser pulado — ou mova-o para ANTES do portão, onde ele roda sempre.";

interface Passo {
  rotulo: string;
  linha: number;
}

interface Leitura {
  /** Caminho relativo à raiz, como aparece na mensagem de erro. */
  arquivo: string;
  linhaDoPortao: number;
  /** `null` = a rota tem o portão e não declara nada. */
  declarados: string[] | null;
  passos: Passo[];
}

function rotasDeCron(): string[] {
  return readdirSync(DIR_CRON, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function caminhoDaRota(rota: string): string {
  return join("app", "api", "v1", "cron", rota, "route.ts");
}

const colapsar = (texto: string): string => texto.replace(/\s+/g, " ").trim();

/** Nome que o `const`/`let` liga, com o padrão de desestruturação como ele é. */
function textoDoVinculo(nome: ts.BindingName, arq: ts.SourceFile): string {
  if (ts.isIdentifier(nome)) return nome.text;
  // A CHAVE da desestruturação (`{ count: totalElegiveis }` -> `count`), não o
  // apelido local: renomear o apelido não é passo novo e não deve reprovar.
  // Os dois padrões são tratados separadamente de propósito: em
  // `ObjectBindingPattern` os elementos são `BindingElement` (têm
  // `propertyName`), e em `ArrayBindingPattern` são `ArrayBindingElement`, que
  // inclui `OmittedExpression` — e `filter` só estreita dentro de um array de
  // tipo único. Misturar os dois num `nome.elements` faz o compilador recusar
  // `propertyName` e `name`.
  if (ts.isObjectBindingPattern(nome)) {
    const partes = nome.elements.map((e) =>
      e.propertyName ? e.propertyName.getText(arq) : textoDoVinculo(e.name, arq),
    );
    return `{${partes.join(", ")}}`;
  }
  const partes = nome.elements
    .filter((e): e is ts.BindingElement => !ts.isOmittedExpression(e))
    .map((e) => textoDoVinculo(e.name, arq));
  return `[${partes.join(", ")}]`;
}

function textoDoAlvo(expr: ts.Expression | ts.VariableDeclarationList, arq: ts.SourceFile): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${textoDoAlvo(expr.expression, arq)}.${expr.name.text}`;
  if (ts.isAwaitExpression(expr)) return `await ${textoDoAlvo(expr.expression, arq)}`;
  if (ts.isCallExpression(expr)) return `${textoDoAlvo(expr.expression, arq)}(...)`;
  if (ts.isVariableDeclarationList(expr))
    return expr.declarations.map((d) => textoDoVinculo(d.name, arq)).join(", ");
  return colapsar(expr.getText(arq));
}

/**
 * O rótulo do passo, derivado da FORMA do código — `const {data, error}`,
 * `if (error)`, `for (item of active)`, `try`, `return`. É o que a rota escreve
 * na declaração e o que a mensagem de erro cita; a ordem é a do arquivo.
 */
function rotuloDoPasso(no: ts.Statement, arq: ts.SourceFile): string {
  if (ts.isVariableStatement(no)) {
    const prefixo = (no.declarationList.flags & ts.NodeFlags.Const) !== 0 ? "const" : "let";
    const nomes = no.declarationList.declarations.map((d) => textoDoVinculo(d.name, arq)).join(", ");
    return `${prefixo} ${nomes}`;
  }
  if (ts.isIfStatement(no)) return `if (${colapsar(no.expression.getText(arq))})`;
  if (ts.isForOfStatement(no))
    return `for (${textoDoAlvo(no.initializer, arq)} of ${textoDoAlvo(no.expression, arq)})`;
  if (ts.isForStatement(no)) return "for";
  if (ts.isTryStatement(no)) return "try";
  if (ts.isReturnStatement(no)) return "return";
  if (ts.isFunctionDeclaration(no)) return `function ${no.name ? no.name.text : "anônima"}`;
  if (ts.isExpressionStatement(no)) return `expr ${textoDoAlvo(no.expression, arq)}`;
  return `(${ts.SyntaxKind[no.kind]})`;
}

const ehChamadaDoPortao = (expr: ts.Expression): boolean =>
  ts.isAwaitExpression(expr) &&
  ts.isCallExpression(expr.expression) &&
  ts.isIdentifier(expr.expression.expression) &&
  expr.expression.expression.text === "recursoOcioso";

function linhaDe(no: ts.Node, arq: ts.SourceFile): number {
  return arq.getLineAndCharacterOfPosition(no.getStart(arq)).line + 1;
}

/** Array literal por dentro de `as const`/`satisfies`/parênteses — a rota usa `as const`. */
function comoArrayLiteral(expr: ts.Expression): ts.ArrayLiteralExpression | null {
  if (ts.isArrayLiteralExpression(expr)) return expr;
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return comoArrayLiteral(expr.expression);
  }
  return null;
}

/** A declaração da rota, lida do módulo (nível superior), não de dentro de função. */
function declaracaoDaRota(arq: ts.SourceFile): string[] | null {
  for (const no of arq.statements) {
    if (!ts.isVariableStatement(no)) continue;
    for (const d of no.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== NOME_DA_DECLARACAO) continue;
      const inicio = d.initializer ? comoArrayLiteral(d.initializer) : null;
      if (!inicio) {
        throw new Error(`${NOME_DA_DECLARACAO} precisa ser um array de strings literais.`);
      }
      return inicio.elements.map((e) => {
        if (!ts.isStringLiteral(e)) {
          throw new Error(`Cada passo de ${NOME_DA_DECLARACAO} precisa ser uma string literal.`);
        }
        return e.text;
      });
    }
  }
  return null;
}

/**
 * Lê uma rota. Devolve `null` quando ela não tem o portão — a esmagadora maioria
 * das 47 rotas de cron; só as do piso ocioso entram na cerca.
 */
export function lerPortao(fonte: string, arquivo: string): Leitura | null {
  const arq = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.Latest, true);

  let portao: ts.IfStatement | undefined;
  const procurar = (no: ts.Node): void => {
    if (portao) return;
    if (ts.isIfStatement(no) && ehChamadaDoPortao(no.expression)) portao = no;
    ts.forEachChild(no, procurar);
  };
  procurar(arq);
  if (!portao) return null;

  let funcao: ts.Node | undefined = portao.parent;
  while (funcao && !ts.isFunctionDeclaration(funcao)) funcao = funcao.parent;
  if (!funcao || !funcao.body) {
    throw new Error(`${arquivo}: o portão não está dentro de um corpo de função — a cerca não sabe ler esta rota.`);
  }

  const corpo = funcao.body.statements;
  const depois = corpo.slice(corpo.indexOf(portao) + 1);

  return {
    arquivo,
    linhaDoPortao: linhaDe(portao, arq),
    declarados: declaracaoDaRota(arq),
    passos: depois.map((no) => ({ rotulo: rotuloDoPasso(no, arq), linha: linhaDe(no, arq) })),
  };
}

/**
 * As divergências entre o que a rota DECLARA e o que ela FAZ abaixo do portão.
 * Vazio = cerca verde. Cada mensagem começa por `arquivo:linha:` do passo.
 */
export function divergencias({ arquivo, linhaDoPortao, declarados, passos }: Leitura): string[] {
  if (declarados === null) {
    return [
      `${arquivo}:${linhaDoPortao}: a rota sai pelo portão do piso ocioso e não declara ` +
        `${NOME_DA_DECLARACAO} — os passos abaixo dele (${passos.map((p) => p.rotulo).join(", ")}) ` +
        `não têm dono e somem em instalação ociosa.`,
    ];
  }
  // Declaração vazia numa rota com portão é sempre erro: toda rota sai com ao
  // menos o `return` da resposta.
  const mensagens: string[] = [];
  const total = Math.max(declarados.length, passos.length);
  for (let i = 0; i < total; i++) {
    const passo = passos[i];
    const declarado = declarados[i];
    if (passo && declarado === undefined) {
      mensagens.push(
        `${arquivo}:${passo.linha}: passo "${passo.rotulo}" abaixo do portão (linha ${linhaDoPortao}) ` +
          `NÃO está em ${NOME_DA_DECLARACAO}[${i}] — em instalação ociosa a rota sai antes dele.`,
      );
    } else if (passo && declarado !== undefined && passo.rotulo !== declarado) {
      mensagens.push(
        `${arquivo}:${passo.linha}: o passo ${i + 1} abaixo do portão é "${passo.rotulo}", ` +
          `mas ${NOME_DA_DECLARACAO}[${i}] diz ${JSON.stringify(declarado)} — a declaração envelheceu.`,
      );
    } else if (!passo && declarado !== undefined) {
      mensagens.push(
        `${arquivo}: ${NOME_DA_DECLARACAO}[${i}] declara ${JSON.stringify(declarado)}, e o arquivo ` +
          `só tem ${passos.length} passo(s) abaixo do portão — a declaração envelheceu.`,
      );
    }
  }
  return mensagens;
}

function lerDaRota(rota: string): Leitura | null {
  const arquivo = caminhoDaRota(rota);
  return lerPortao(readFileSync(join(RAIZ, arquivo), "utf8"), arquivo);
}

describe("portão do piso ocioso × passo abaixo dele (#3773)", () => {
  it("o instrumento enxerga as rotas e as cinco declarações (controle positivo)", () => {
    // Sem isto, um `readdir` vazio ou um AST que nunca casa o portão fariam o
    // caso abaixo passar por vacuidade: "zero divergências" seria verdade e não
    // significaria nada.
    const rotas = rotasDeCron();
    expect(rotas.length).toBeGreaterThan(20);
    const comPortao = rotas.filter((rota) => lerDaRota(rota) !== null);
    expect(comPortao).toEqual(expect.arrayContaining(ROTAS_CONHECIDAS));
    for (const rota of comPortao) {
      const leitura = lerDaRota(rota);
      expect(leitura?.declarados, `${caminhoDaRota(rota)} não declara ${NOME_DA_DECLARACAO}`).not.toBeNull();
      expect((leitura?.declarados ?? []).length, `${caminhoDaRota(rota)} declara uma lista vazia`).toBeGreaterThan(0);
    }
  });

  it.each(rotasDeCron())("%s: todo passo abaixo do portão está declarado", (rota) => {
    const leitura = lerDaRota(rota);
    // Rota sem o portão não tem o que declarar: a cerca não opina sobre ela.
    if (leitura === null) return;
    expect(divergencias(leitura), AJUDA).toEqual([]);
  });

  describe("o instrumento acusa (controle negativo, em rota sintética)", () => {
    const ROTA = `
      import { ok } from "@/lib/api/wrappers";
      import { recursoOcioso } from "@/lib/cron/piso-ocioso";

      const PASSOS_DEPOIS_DO_PORTAO = ["const db", "const {data, error}", "if (error)", "return"];
      void PASSOS_DEPOIS_DO_PORTAO;

      async function handle() {
        if (await recursoOcioso("campanhas")) return ok({ pulado: "recurso_ocioso" });
        const db = createAdminClient();
        const { data, error } = await ler(db);
        if (error) return ok({ erro: true });
        return ok(data);
      }
    `;

    it("não acusa nada quando a declaração bate com o arquivo", () => {
      const leitura = lerPortao(ROTA, "rota-sintetica.ts");
      expect(leitura).not.toBeNull();
      expect(divergencias(leitura!)).toEqual([]);
    });

    it("acusa o passo novo que ninguém declarou, apontando arquivo e linha", () => {
      const comPassoNovo = ROTA.replace("        return ok(data);", "        await auditar(data);\n        return ok(data);");
      const leitura = lerPortao(comPassoNovo, "rota-sintetica.ts");
      const mensagens = divergencias(leitura!);
      // Duas: o passo novo ocupa o índice que era do `return`, e o `return`
      // desloca para um índice que ninguém declarou. As duas apontam linha.
      expect(mensagens.length).toBeGreaterThan(0);
      expect(mensagens[0]).toMatch(/^rota-sintetica\.ts:\d+: o passo 4 abaixo do portão é "expr await auditar\(\.\.\.\)"/);
      expect(mensagens.join("\n")).toContain("NÃO está em PASSOS_DEPOIS_DO_PORTAO[4]");
    });

    it("acusa a declaração fora de ordem — o passo trocado de lugar também some", () => {
      const trocada = ROTA.replace(
        '["const db", "const {data, error}", "if (error)", "return"]',
        '["const {data, error}", "const db", "if (error)", "return"]',
      );
      const mensagens = divergencias(lerPortao(trocada, "rota-sintetica.ts")!);
      expect(mensagens.length).toBeGreaterThan(0);
      expect(mensagens[0]).toMatch(/^rota-sintetica\.ts:\d+: o passo 1 abaixo do portão é "const db"/);
    });

    it("acusa a rota que tem o portão e não declara nada", () => {
      const semDeclaracao = ROTA.replace(/const PASSOS_DEPOIS_DO_PORTAO = \[[\s\S]*?\]\;\n\s*void PASSOS_DEPOIS_DO_PORTAO;\n/, "");
      const mensagens = divergencias(lerPortao(semDeclaracao, "rota-sintetica.ts")!);
      expect(mensagens).toHaveLength(1);
      expect(mensagens[0]).toContain(`não declara ${NOME_DA_DECLARACAO}`);
    });

    it("só o nível superior é declarado — passo DENTRO de bloco existente não entra (limite conhecido)", () => {
      // Não é folga: o `for` já só roda quando houve linha para ela processar,
      // então o portão não é o que desliga o que está dentro dele. O limite está
      // registrado no cabeçalho e no corpo do PR.
      const comPassoDentroDoLaco = `
        import { recursoOcioso } from "@/lib/cron/piso-ocioso";
        const PASSOS_DEPOIS_DO_PORTAO = ["for (l of linhas)", "return"];
        async function handle() {
          if (await recursoOcioso("historico")) return ok({ pulado: "recurso_ocioso" });
          for (const l of linhas) {
            await fecharAviso(l);
          }
          return ok({});
        }
      `;
      const leitura = lerPortao(comPassoDentroDoLaco, "rota-sintetica.ts")!;
      expect(leitura.passos.map((p) => p.rotulo)).toEqual(["for (l of linhas)", "return"]);
      expect(divergencias(leitura)).toEqual([]);
    });
  });
});
