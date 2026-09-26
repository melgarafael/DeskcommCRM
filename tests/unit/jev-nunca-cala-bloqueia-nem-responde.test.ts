/**
 * O JEV NUNCA CALA, BLOQUEIA NEM RESPONDE O CLIENTE (R3 do plano da onda 2).
 *
 * O Jev é barato, rápido e erra de um jeito que ninguém ainda mediu em cada
 * tarefa nova. Por isso o que ele decide é sempre um SINAL: a nota do clima,
 * uma escolha, um aviso na Central. Quem cala a conversa (`bot_silenced_until`),
 * passa para humano (`force_human`), bloqueia o contato (`is_blocked`) ou manda
 * mensagem é o mecanismo de sempre, que lê o sinal — nunca o módulo do Jev.
 *
 * A cerca parte de `lib/ai/decisao/**`, onde mora todo módulo do Jev (a mesma
 * premissa de `pontos-de-ia-decisao-rapida.test.ts`), e reprova:
 *
 *  1. qualquer menção CÓDIGO às três colunas nos módulos do Jev — comentário
 *     não conta, lido pelo scanner do TypeScript, que descarta comentário (o
 *     comentário que explica a proibição contém a palavra proibida) — como
 *     identificador, como texto inteiro, ou DENTRO de um texto (o SQL cru);
 *  2. import de módulo que envia algo a alguém ou passa a conversa adiante —
 *     pelo alias `@/` OU por caminho relativo (`../../waha/send`), que o repo
 *     também usa entre módulos: o especificador é resolvido contra a pasta do
 *     arquivo antes de casar;
 *  3. escrita (insert/update/upsert/delete) nas tabelas da conversa, inclusive
 *     com a consulta guardada numa variável; escrita numa tabela que não é um
 *     texto fixo (não se sabe qual é) e toda chamada `.rpc()` (a cerca não vê
 *     o que a função escreve) também reprovam. E a escrita em SQL CRU — o
 *     `pool.query("update public.conversations …")` —, que é como os módulos
 *     da onda 2 escrevem: a cerca só via a cadeia do supabase-js, e um
 *     `update … set bot_silenced_until` por `pool.query` passava pelos três
 *     detectores (achado da revisão, medido). O SQL é lido nos textos do código
 *     — literal, template com e sem `${}` —, nunca nos comentários.
 *     ponytail: a consulta que chega por PARÂMETRO de função não é seguida — o
 *     próximo passo, se um módulo do Jev passar a receber um cliente de fora,
 *     é seguir a chamada até quem o criou.
 *
 * As regras 2 e 3 valem para TUDO o que o Jev executa, e não só para os
 * arquivos da pasta: o import é seguido dentro do repo, e cada módulo alcançado
 * passa pelas duas. Um Jev que chama `triggerHandoff` não menciona coluna
 * nenhuma nem importa o WAHA — quem cala a conversa e avisa o cliente é o
 * módulo importado (achado da revisão: só o import direto era visto, e
 * importar o handoff passava verde). A regra 1 fica nos módulos do Jev: fora
 * deles, LER `is_blocked` é legítimo, e escrevê-lo já é a regra 3.
 * `import type` não é seguido: some na compilação e não executa nada.
 * ponytail: `lib/channels` inteiro conta como quem envia, e há utilitário puro
 * lá dentro (`phone-variants`, alcançado por `lib/contacts/rotulo-do-contato`).
 * Se o Jev precisar de um deles, estreite o prefixo para os transportes
 * (`adapters`, `transporte`) em vez de abrir exceção por arquivo.
 *
 * Cada regra tem controle positivo: uma varredura quebrada devolve zero, e zero
 * se lê como "tudo certo".
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const COLUNAS_QUE_CALAM = /^(is_blocked|force_human|bot_silenced_until)$/;
/** As mesmas colunas no MEIO de um texto — o SQL cru que as escreve. */
const COLUNAS_NO_TEXTO = /\b(is_blocked|force_human|bot_silenced_until)\b/;
/** Escrita em SQL cru numa tabela da conversa. */
const ESCRITA_EM_SQL = /\b(update|insert\s+into|delete\s+from)\s+(public\.)?(messages|conversations|contacts)\b/i;

/**
 * Módulos que mandam mensagem, e-mail ou notificação, ou que passam a conversa
 * a uma pessoa, em caminho a partir da raiz (ver `moduloNoRepo`). Prefixo: um
 * arquivo novo dentro deles já nasce proibido, e o índice da pasta também.
 */
const QUEM_ENVIA = [
  /^lib\/waha(\/|$)/,
  /^lib\/channels(\/|$)/,
  /^lib\/agent-engine\/edge\/crm(\/|$)/,
  /^lib\/agent-engine\/agent(\/|$)/,
  /^lib\/ai\/runtime(\/|$)/,
  /^lib\/followup(\/|$)/,
  /^lib\/email(\/|$)/,
  /^lib\/notifications(\/|$)/,
  /^lib\/escalacao(\/|$)/,
  /^lib\/prospecting(\/|$)/,
  /^lib\/ai\/handoff(\/|$)/,
  /^app\/api\/v1\/messages(\/|$)/,
  /^lib\/campanhas(\/|$)/,
];

/** Um de cada prefixo, que existe e envia (ou passa adiante) — o controle de `QUEM_ENVIA`. */
const REMETENTES_CONHECIDOS = [
  "lib/waha/send",
  "lib/channels/transporte",
  "lib/agent-engine/edge/crm/send-message",
  "lib/agent-engine/agent/split-message",
  "lib/ai/runtime/finalize",
  "lib/followup/enviar-texto-fixo",
  "lib/email/roteador",
  "lib/notifications/web_push",
  "lib/escalacao/passagem",
  "lib/prospecting/worker",
  "lib/ai/handoff/orchestrator",
  "app/api/v1/messages/_handler",
  "lib/campanhas/rodada",
];

/**
 * O módulo que `especificador` alcança, a partir da raiz do repo: `@/x` vira
 * `x`, e `./x`/`../x` é resolvido contra a pasta de `arquivo`. Pacote (`zod`)
 * volta como veio e não casa com nenhuma regra.
 */
function moduloNoRepo(arquivo: string, especificador: string): string {
  if (especificador.startsWith("@/")) return especificador.slice(2);
  if (!especificador.startsWith(".")) return especificador;
  return path.posix.normalize(path.posix.join(path.posix.dirname(arquivo), especificador));
}

function importsDeQuemEnvia(arquivo: string, texto: string): string[] {
  return modulosImportados(texto).filter((mod) => QUEM_ENVIA.some((r) => r.test(moduloNoRepo(arquivo, mod))));
}

const TABELAS_DA_CONVERSA = new Set(["messages", "conversations", "contacts"]);
const ESCRITAS = new Set(["insert", "update", "upsert", "delete"]);

function fonteDe(texto: string): ts.SourceFile {
  return ts.createSourceFile("x.ts", texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Identificadores e textos do CÓDIGO, sem comentário. */
function tokensDoCodigo(texto: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, texto);
  const tokens: string[] = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.Identifier) tokens.push(scanner.getTokenText());
    else if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      tokens.push(scanner.getTokenValue());
    }
  }
  return tokens;
}

/**
 * O texto de todo literal do CÓDIGO — aspas, crase sem `${}` e crase com `${}`
 * (as partes fixas entre as substituições). Pela árvore, e não pelo scanner:
 * o scanner lê o que vem depois do `}` de um template como código.
 */
function textosDoCodigo(texto: string): string[] {
  const textos: string[] = [];
  const visitar = (no: ts.Node): void => {
    if (ts.isStringLiteral(no) || ts.isNoSubstitutionTemplateLiteral(no)) textos.push(no.text);
    else if (ts.isTemplateExpression(no)) {
      textos.push([no.head.text, ...no.templateSpans.map((s) => s.literal.text)].join(" "));
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonteDe(texto));
  return textos;
}

/** `pool.query("update public.contacts …")` e afins, em qualquer literal do código. */
function escritasEmSqlCru(texto: string): string[] {
  return textosDoCodigo(texto).flatMap((t) => {
    const achado = ESCRITA_EM_SQL.exec(t);
    return achado ? [`SQL cru: ${achado[0]}`] : [];
  });
}

/** Os módulos que o arquivo carrega ao rodar — `import type`/`export type` não contam. */
function modulosImportados(texto: string): string[] {
  const modulos: string[] = [];
  const visitar = (no: ts.Node): void => {
    const soTipo =
      (ts.isImportDeclaration(no) && no.importClause?.isTypeOnly === true) ||
      (ts.isExportDeclaration(no) && no.isTypeOnly);
    if (
      (ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) &&
      !soTipo &&
      no.moduleSpecifier &&
      ts.isStringLiteral(no.moduleSpecifier)
    ) {
      modulos.push(no.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(no) &&
      no.expression.kind === ts.SyntaxKind.ImportKeyword &&
      no.arguments[0] &&
      ts.isStringLiteralLike(no.arguments[0])
    ) {
      modulos.push(no.arguments[0].text);
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonteDe(texto));
  return modulos;
}

/** A tabela da cadeia não é um texto fixo: pode ser qualquer uma, a da conversa inclusive. */
const TABELA_DESCONHECIDA = "<tabela que não é texto fixo>";

/**
 * `x.from("messages")….update(…)` e afins: a tabela é a do `.from` mais perto
 * na cadeia — seguindo a variável que guarda a consulta (`const q =
 * admin.from(…)`), no mesmo arquivo. `.from(tabela)` com uma variável vale
 * como tabela desconhecida, e `.rpc(…)` reprova sempre.
 */
function escritasNaConversa(texto: string): string[] {
  const achadas: string[] = [];
  const fonte = fonteDe(texto);
  const iniciais = new Map<string, ts.Expression>();
  const juntar = (no: ts.Node): void => {
    if (ts.isVariableDeclaration(no) && ts.isIdentifier(no.name) && no.initializer) {
      iniciais.set(no.name.text, no.initializer);
    }
    ts.forEachChild(no, juntar);
  };
  juntar(fonte);

  const tabelaDaCadeia = (e: ts.Expression, vistos: Set<string>): string | null => {
    let atual: ts.Expression = e;
    for (;;) {
      if (ts.isCallExpression(atual)) {
        const chamada = atual.expression;
        const arg = atual.arguments[0];
        if (ts.isPropertyAccessExpression(chamada) && chamada.name.text === "from") {
          return arg && ts.isStringLiteralLike(arg) ? arg.text : TABELA_DESCONHECIDA;
        }
        atual = chamada;
      } else if (ts.isPropertyAccessExpression(atual)) {
        atual = atual.expression;
      } else if (ts.isAwaitExpression(atual) || ts.isParenthesizedExpression(atual)) {
        atual = atual.expression;
      } else {
        const inicial = ts.isIdentifier(atual) && !vistos.has(atual.text) ? iniciais.get(atual.text) : undefined;
        if (inicial === undefined) return null;
        vistos.add(atual.getText(fonte));
        atual = inicial;
      }
    }
  };
  const linhaDe = (no: ts.Node) => fonte.getLineAndCharacterOfPosition(no.getStart()).line + 1;
  const visitar = (no: ts.Node): void => {
    if (ts.isCallExpression(no) && ts.isPropertyAccessExpression(no.expression)) {
      const metodo = no.expression.name.text;
      if (metodo === "rpc") {
        achadas.push(`rpc (linha ${linhaDe(no)}): a cerca não vê o que a função escreve`);
      } else if (ESCRITAS.has(metodo)) {
        const tabela = tabelaDaCadeia(no.expression.expression, new Set());
        if (tabela !== null && (TABELAS_DA_CONVERSA.has(tabela) || tabela === TABELA_DESCONHECIDA)) {
          achadas.push(`${metodo} em ${tabela} (linha ${linhaDe(no)})`);
        }
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return achadas;
}

type Modulo = { arquivo: string; texto: string };

/** O arquivo do repo que o módulo é (`.ts`, `.tsx` ou o índice da pasta), ou null: pacote. */
function arquivoDoModulo(modulo: string): string | null {
  return [`${modulo}.ts`, `${modulo}.tsx`, `${modulo}/index.ts`, `${modulo}/index.tsx`].find((c) => existsSync(c)) ?? null;
}

/**
 * Tudo o que `inicio` executa dentro do repo, cada módulo com a cadeia de
 * imports que leva até ele — a cadeia é o que diz a quem lê a falha POR ONDE
 * o Jev chegou ao remetente.
 */
function alcancados(inicio: readonly Modulo[]): Array<Modulo & { cadeia: string[] }> {
  const fila = inicio.map((m) => ({ ...m, cadeia: [m.arquivo] }));
  const vistos = new Set(fila.map((m) => m.arquivo));
  for (const atual of fila) {
    for (const mod of modulosImportados(atual.texto)) {
      const arquivo = arquivoDoModulo(moduloNoRepo(atual.arquivo, mod));
      if (arquivo === null || vistos.has(arquivo)) continue;
      vistos.add(arquivo);
      fila.push({ arquivo, texto: readFileSync(arquivo, "utf8"), cadeia: [...atual.cadeia, arquivo] });
    }
  }
  return fila;
}

function violacoesDeEnvio(alcance: ReturnType<typeof alcancados>): string[] {
  return alcance.flatMap((m) => importsDeQuemEnvia(m.arquivo, m.texto).map((mod) => `${m.cadeia.join(" → ")} → ${mod}`));
}

function violacoesDeEscrita(alcance: ReturnType<typeof alcancados>): string[] {
  return alcance.flatMap((m) =>
    [...escritasNaConversa(m.texto), ...escritasEmSqlCru(m.texto)].map((e) => `${m.cadeia.join(" → ")}: ${e}`),
  );
}

/** As três colunas num módulo do Jev: identificador, texto inteiro ou dentro de um texto. */
function colunasQueCalam(texto: string): string[] {
  const noCodigo = tokensDoCodigo(texto).filter((t) => COLUNAS_QUE_CALAM.test(t));
  const nosTextos = textosDoCodigo(texto).flatMap((t) => {
    const achado = COLUNAS_NO_TEXTO.exec(t);
    return achado ? [achado[1]!] : [];
  });
  return [...new Set([...noCodigo, ...nosTextos])];
}

const modulosDoJev: Modulo[] = arquivosDeCodigo(["lib/ai/decisao"]).map((abs) => ({
  arquivo: caminhoRelativo(abs),
  texto: readFileSync(abs, "utf8"),
}));
const alcanceDoJev = alcancados(modulosDoJev);

describe("o Jev nunca cala, bloqueia nem responde o cliente", () => {
  it("a varredura enxerga os módulos do Jev (controle positivo)", () => {
    const arquivos = modulosDoJev.map((m) => m.arquivo);
    expect(arquivos).toContain("lib/ai/decisao/clima.ts");
    expect(arquivos).toContain("lib/ai/decisao/aviso.ts");
    expect(arquivos.some((a) => a.endsWith(".test.ts")), "teste não é módulo do Jev").toBe(false);
  });

  it("os três detectores acusam o que devem, e só isso (sabotagem sintética)", () => {
    expect(tokensDoCodigo(`// nunca escreve force_human\nconst x = 1;`).some((t) => COLUNAS_QUE_CALAM.test(t))).toBe(false);
    expect(tokensDoCodigo(`db.update({ force_human: true })`).some((t) => COLUNAS_QUE_CALAM.test(t))).toBe(true);
    expect(tokensDoCodigo(`db.update({ "bot_silenced_until": agora })`).some((t) => COLUNAS_QUE_CALAM.test(t))).toBe(true);

    expect(modulosImportados(`import { enviar } from "@/lib/waha/send";`)).toEqual(["@/lib/waha/send"]);
    expect(modulosImportados(`const m = await import('@/lib/email/roteador');`)).toEqual(["@/lib/email/roteador"]);
    // O caminho relativo alcança o mesmo remetente que o alias (achado da revisão:
    // só o `@/` era visto, e `../../waha/send` passava verde).
    const doJev = "lib/ai/decisao/qualquer.ts";
    expect(importsDeQuemEnvia(doJev, `import * as e from "../../waha/send";`)).toEqual(["../../waha/send"]);
    expect(importsDeQuemEnvia(doJev, `export { passar } from "../../escalacao/passagem";`)).toHaveLength(1);
    expect(importsDeQuemEnvia(doJev, `import { x } from "@/lib/waha";`), "o índice da pasta também").toHaveLength(1);
    expect(importsDeQuemEnvia(doJev, `import { medir } from "./cliente";`)).toEqual([]);
    expect(importsDeQuemEnvia(doJev, `import { z } from "zod";`)).toEqual([]);
    expect(importsDeQuemEnvia(doJev, `import type { Envio } from "@/lib/waha/send";`), "tipo não executa").toEqual([]);

    expect(escritasNaConversa(`await admin.from("messages").insert({ body: "oi" });`)).toHaveLength(1);
    expect(escritasNaConversa(`await db.from('conversations').update({ x: 1 }).eq("id", id);`)).toHaveLength(1);
    expect(escritasNaConversa(`await admin.from("agent_inbox_items").insert({ title });`)).toEqual([]);
    expect(escritasNaConversa(`await db.from("messages").select("id").eq("id", id);`)).toEqual([]);
    // A consulta guardada numa variável, a tabela numa variável e a função do banco.
    expect(escritasNaConversa(`const q = admin.from("contacts");\nawait q.update({ x: 1 });`)).toHaveLength(1);
    expect(escritasNaConversa(`const t = "messages";\nawait admin.from(t).insert({ body });`)).toHaveLength(1);
    expect(escritasNaConversa(`await admin.rpc("fn_qualquer", { p: 1 });`)).toHaveLength(1);
    // Um `Set.delete` não é escrita no banco (o aviso tem um).
    expect(escritasNaConversa(`const vistos = new Set<string>();\nvistos.delete(id);`)).toEqual([]);

    // SQL cru pelo `pg.Pool` — o jeito como a onda 2 escreve. Medido pela
    // revisão: os três casos abaixo passavam pelos três detectores antigos.
    const calar = `await pool.query("update public.conversations set bot_silenced_until = now() where id = $1", [id]);`;
    expect(escritasEmSqlCru(calar)).toHaveLength(1);
    expect(colunasQueCalam(calar)).toEqual(["bot_silenced_until"]);
    const bloquear = "await pool.query(`update public.contacts set is_blocked = true where id = ${id}`);";
    expect(escritasEmSqlCru(bloquear)).toHaveLength(1);
    expect(colunasQueCalam(bloquear)).toEqual(["is_blocked"]);
    expect(escritasEmSqlCru("await pool.query(`insert into public.messages (body) values ($1)`, [b]);")).toHaveLength(1);
    expect(escritasEmSqlCru(`await pool.query("delete from messages where id = $1", [id]);`)).toHaveLength(1);
    // O comentário que explica a proibição não reprova, e LER não é escrever.
    expect(escritasEmSqlCru(`// nunca "update public.conversations"\nconst x = 1;`)).toEqual([]);
    expect(escritasEmSqlCru(`await pool.query("select settings from public.organizations where id = $1");`)).toEqual([]);
    expect(escritasEmSqlCru(`await pool.query("select is_blocked from public.contacts where id = $1");`)).toEqual([]);
  });

  it("o SQL cru dos módulos do Jev é lido — e as escritas dele são nas tabelas do Jev (controle positivo)", () => {
    const manipulacao = modulosDoJev.find((m) => m.arquivo === "lib/ai/decisao/manipulacao.ts")!;
    const escritas = textosDoCodigo(manipulacao.texto).filter((t) => /\binsert\s+into\b/i.test(t));
    // Sem este controle, um `textosDoCodigo` quebrado devolveria zero e o caso de baixo passaria vazio.
    expect(escritas.join(" ")).toMatch(/insert into public\.jev_observacoes/);
    expect(escritas.join(" ")).toMatch(/insert into public\.llm_calls/);
    expect(escritasEmSqlCru(manipulacao.texto)).toEqual([]);
  });

  it("o import é seguido até quem envia e quem escreve, com a cadeia (sabotagem com código real)", () => {
    const doJev = (texto: string) => alcancados([{ arquivo: "lib/ai/decisao/zz-sabotagem.ts", texto }]);

    // O achado da revisão: o Jev chama o handoff, que cala a conversa e avisa o
    // cliente. O import direto já reprova, e a escrita do handoff aparece junto.
    const handoff = doJev(`import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";`);
    expect(violacoesDeEnvio(handoff)[0]).toBe("lib/ai/decisao/zz-sabotagem.ts → @/lib/ai/handoff/orchestrator");
    expect(
      violacoesDeEscrita(handoff).some((v) => v.startsWith("lib/ai/decisao/zz-sabotagem.ts → lib/ai/handoff/orchestrator.ts: update em conversations")),
      "a escrita de bot_silenced_until mora no módulo importado",
    ).toBe(true);

    // Um intermediário FORA da lista de remetentes, que envia pelo handler: só
    // o segundo salto o alcança.
    const intermediario = doJev(`import * as m from "../../mcp/tools/messages";`);
    expect(violacoesDeEnvio(intermediario)).toContain(
      "lib/ai/decisao/zz-sabotagem.ts → lib/mcp/tools/messages.ts → @/app/api/v1/messages/_handler",
    );

    expect(violacoesDeEnvio(doJev(`import type { HandoffInput } from "@/lib/ai/handoff/orchestrator";`))).toEqual([]);
  });

  it("o alcance do Jev sai da pasta (controle positivo do percurso)", () => {
    const arquivos = alcanceDoJev.map((m) => m.arquivo);
    expect(arquivos).toContain("lib/supabase/admin.ts");
    expect(arquivos.length).toBeGreaterThan(modulosDoJev.length);
  });

  it("toda regra de remetente alcança um remetente que existe (controle de QUEM_ENVIA)", () => {
    const ausentes = REMETENTES_CONHECIDOS.filter((m) => !existsSync(`${m}.ts`) && !existsSync(`${m}.tsx`));
    expect(ausentes, "remetente de controle mudou de lugar — atualize a lista").toEqual([]);
    const semRegra = QUEM_ENVIA.filter((r) => !REMETENTES_CONHECIDOS.some((m) => r.test(m)));
    expect(semRegra.map(String), "regra sem remetente conhecido: não se sabe se ela alcança algo").toEqual([]);
  });

  it("nenhum módulo do Jev toca is_blocked, force_human ou bot_silenced_until", () => {
    const tocam = modulosDoJev.flatMap((m) => {
      const colunas = colunasQueCalam(m.texto);
      return colunas.length > 0 ? [`${m.arquivo}: ${colunas.join(", ")}`] : [];
    });
    expect(tocam, "o Jev só dá o sinal; quem cala, passa ou bloqueia é o mecanismo de sempre").toEqual([]);
  });

  it("nada que o Jev executa importa quem envia mensagem ou passa a conversa", () => {
    expect(violacoesDeEnvio(alcanceDoJev), "o Jev nunca fala com o cliente nem chama uma pessoa por conta própria").toEqual([]);
  });

  it("nada que o Jev executa escreve na mensagem, na conversa ou no contato", () => {
    expect(violacoesDeEscrita(alcanceDoJev)).toEqual([]);
  });
});
