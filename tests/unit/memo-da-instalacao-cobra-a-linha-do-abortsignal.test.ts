/**
 * ═══ TODA LEITURA QUE ALIMENTA MEMO DA INSTALAÇÃO CARREGA O `signal` ═══
 *
 * O PR #2795 consertou a classe "memo da instalação fora da deduplicação do
 * render" escolhendo a decisão (ii): uma linha `.abortSignal(new
 * AbortController().signal)` em cada leitura que alimenta um memo de módulo ou
 * `globalThis` com TTL/geração. O próprio PR declarou o resto em aberto — "um
 * memo novo precisa lembrar da linha. Nenhum gate cobra isso hoje." Este arquivo
 * é esse gate.
 *
 * ## O que a cerca cobra
 *
 * A deduplicação de `fetch` do Next dentro de um render devolve a QUALQUER GET
 * repetido a resposta guardada da primeira ida — a menos que ele leve um
 * `signal`, o opt-out que a fonte declara. Sem a linha, um memo que vence (ou é
 * invalidado) no meio de um render recebe a resposta de ANTES da escrita e a
 * memoiza por um TTL inteiro. O porquê medido vive em
 * `tests/unit/memo-da-instalacao-fora-do-dedupe-do-render.test.ts`, que prova o
 * comportamento no runtime; aqui a pergunta é ESTRUTURAL: a linha está escrita
 * em cada leitura memoizada?
 *
 * ## Por que uma varredura, e não a leitura do arquivo inteiro
 *
 * Assertar que o TEXTO do arquivo contém `.abortSignal(...)` passaria por
 * acidente: a linha pode estar em qualquer ponto do módulo, inclusive numa
 * consulta que NÃO alimenta memo. O scanner abaixo resolve a cadeia
 * `createAdminClient().from("t").select(...).abortSignal(...).maybeSingle()` no
 * AST e pergunta, por ELITE de cadeia, se o `signal` está ali — e se o
 * argumento é um `AbortController` NOVO (`new AbortController().signal`), e não
 * um signal reutilizado, que chegaria abortado e desligaria a leitura.
 *
 * ## Controles (sem eles o verde não prova nada)
 *
 *   1. UM FONTE SINTÉTICO com três formas — com opt-out, sem opt-out e com
 *      signal reutilizado — prova que o scanner DISTINGUE as três. Uma varredura
 *      que devolvesse vazio (ou tudo verde) é silêncio, não veredito.
 *   2. A varredura global confere que cada um dos arquivos tem ao menos uma
 *      leitura memoizada (não-vacuidade): zero cadeias encontradas é instrumento
 *      morto, não "tudo em ordem".
 *
 * O escopo é a lista `SITIOS` — as 6 leituras que o PR #2795 consertou. Um memo
 * NOVO num desses arquivos entra sozinho na varredura global e é cobrado; um
 * arquivo de memo fora da lista precisa ser somado a `SITIOS`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ehClienteDeServico, nomesDoClienteAdmin } from "./helpers/cliente-admin";
import { RAIZ_DO_REPO } from "./helpers/varrer-codigo";

/** O opt-out que o PR #2795 escolheu, escrito uma vez só. */
const LINHA_ESPERADA = ".abortSignal(new AbortController().signal)";

/** Uma leitura memoizada achada no AST de um arquivo. */
interface Leitura {
  /** O nome da tabela do `.from("…")`, ou `"?"` quando não é literal. */
  readonly tabela: string;
  /** A cadeia leva `.abortSignal(new AbortController().signal)`? */
  readonly temOptOut: boolean;
}

/** Um memorial de leitura que a cerca cobra: onde lê, onde memoiza, qual a prova. */
interface Sitio {
  readonly chave: string;
  /** Arquivo com a LEITURA (`createAdminClient()...maybeSingle()`). */
  readonly arquivoDaLeitura: string;
  /** Tabela que a cadeia lê — prende a leitura ao sítio declarado. */
  readonly tabela: string;
  /** Arquivo onde mora o memo de módulo/`globalThis`. */
  readonly arquivoDoMemo: string;
  /** Trecho que prova o TTL/geração do memo — é o que o `signal` protege. */
  readonly marcadorDoMemo: string;
}

const SITIOS: Sitio[] = [
  {
    chave: "marca da instalação",
    arquivoDaLeitura: "lib/branding/instalacao.ts",
    tabela: "platform_branding",
    arquivoDoMemo: "lib/branding/instalacao.ts",
    marcadorDoMemo: "expiraEm: Date.now() + TTL_MS",
  },
  {
    // A leitura que alimenta este memo NÃO mora no próprio arquivo: é o `lerLinha`
    // de `lib/instalacao/config.ts` (via `valorDaInstalacao`).
    chave: "CSS personalizado",
    arquivoDaLeitura: "lib/instalacao/config.ts",
    tabela: "platform_config",
    arquivoDoMemo: "lib/branding/css-personalizado.ts",
    marcadorDoMemo: "expiraEm: Date.now() + TTL_MEMO_MS",
  },
  {
    chave: "comportamento da instalação",
    arquivoDaLeitura: "lib/instalacao/comportamento-servidor.ts",
    tabela: "platform_settings",
    arquivoDoMemo: "lib/instalacao/comportamento.ts",
    marcadorDoMemo: "expiraEm: Date.now() + TTL_MS",
  },
  {
    chave: "modo de cadastro",
    arquivoDaLeitura: "lib/auth/politica-de-cadastro.ts",
    tabela: "platform_settings",
    arquivoDoMemo: "lib/auth/politica-de-cadastro.ts",
    marcadorDoMemo: "expiraEm: Date.now() + TTL_MS",
  },
  {
    chave: "credencial do Google Agenda",
    arquivoDaLeitura: "lib/agenda/google/config.ts",
    tabela: "platform_google_oauth",
    arquivoDoMemo: "lib/agenda/google/config.ts",
    marcadorDoMemo: "expiraEm: Date.now() + TTL_MS",
  },
  {
    chave: "app da Meta",
    arquivoDaLeitura: "lib/channels/meta/app.ts",
    tabela: "platform_meta_app",
    arquivoDoMemo: "lib/channels/meta/app.ts",
    marcadorDoMemo: "expiraEm: Date.now() + TTL_MS",
  },
];

/** Um passo `.metodo(...)` da cadeia e a chamada que o aplica. */
interface Passo {
  readonly metodo: string;
  readonly chamada: ts.CallExpression;
}

/**
 * Os passos `.metodo(...)` que COMPÕEM a cadeia que termina em `no`, de FORA
 * para dentro: em `x.from("t").select("a").maybeSingle()`, a partir do
 * `maybeSingle` devolve `maybeSingle`, `select`, `from`.
 */
function passosDeForaParaDentro(no: ts.CallExpression): Passo[] {
  const passos: Passo[] = [];
  let atual: ts.Node = no;
  while (ts.isCallExpression(atual) && ts.isPropertyAccessExpression(atual.expression)) {
    passos.push({ metodo: atual.expression.name.text, chamada: atual });
    let receptor: ts.Node = atual.expression.expression;
    while (ts.isParenthesizedExpression(receptor) || ts.isAwaitExpression(receptor)) {
      receptor = receptor.expression;
    }
    atual = receptor;
  }
  return passos;
}

/**
 * O argumento é um `signal` NOVO — `new AbortController().signal`?
 *
 * O `new` é o ponto: um `AbortController` guardado num módulo e reusado chega
 * possivelmente ABORTADO, e um signal abortado transforma a leitura num `throw`
 * — o mesmo defeito por outra porta.
 */
function ehSignalNovo(no: ts.Expression | undefined): boolean {
  if (no === undefined || !ts.isPropertyAccessExpression(no)) return false;
  if (no.name.text !== "signal") return false;
  const alvo = no.expression;
  return (
    ts.isNewExpression(alvo) &&
    ts.isIdentifier(alvo.expression) &&
    alvo.expression.text === "AbortController"
  );
}

/**
 * As leituras MEMOIZADAS de um arquivo: as cadeias que
 *   1. terminam em `.maybeSingle()` — a leitura de uma linha da instalação;
 *   2. começam em `createAdminClient()` (`from` e depois `select` logo acima);
 *   3. NÃO são o `select` de uma escrita (o caminho de `semear`, cuja raiz é a
 *      variável com o builder do `insert`/`update`) — por isso `from`/`select`
 *      têm de ser os DOIS passos mais internos da cadeia.
 */
function leiturasMemoizadas(fonte: ts.SourceFile): Leitura[] {
  const admins = nomesDoClienteAdmin(fonte);
  const leituras: Leitura[] = [];

  const visitar = (no: ts.Node): void => {
    if (
      ts.isCallExpression(no) &&
      ts.isPropertyAccessExpression(no.expression) &&
      no.expression.name.text === "maybeSingle" &&
      ehClienteDeServico(no.expression, admins)
    ) {
      const deDentro = [...passosDeForaParaDentro(no)].reverse();
      const doFrom = deDentro[0];
      const doSelect = deDentro[1];
      if (doFrom !== undefined && doSelect !== undefined) {
        if (doFrom.metodo === "from" && doSelect.metodo === "select") {
          const argumento = doFrom.chamada.arguments[0];
          leituras.push({
            tabela:
              argumento !== undefined && ts.isStringLiteral(argumento) ? argumento.text : "?",
            temOptOut: deDentro.some(
              (passo) => passo.metodo === "abortSignal" && ehSignalNovo(passo.chamada.arguments[0]),
            ),
          });
        }
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);

  return leituras;
}

const fontesLidas = new Map<string, ts.SourceFile>();

/** O AST de um arquivo do repositório, com os pais ligados (a varredura os usa). */
function fonteDoArquivo(relativo: string): ts.SourceFile {
  const conhecida = fontesLidas.get(relativo);
  if (conhecida !== undefined) return conhecida;
  const absoluto = path.join(RAIZ_DO_REPO, relativo);
  const fonte = ts.createSourceFile(
    absoluto,
    readFileSync(absoluto, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  fontesLidas.set(relativo, fonte);
  return fonte;
}

/** O AST de um fonte sintético — o controle positivo do scanner. */
function fonteDeControle(texto: string): ts.SourceFile {
  return ts.createSourceFile("controle.ts", texto, ts.ScriptTarget.Latest, true);
}

describe("o scanner enxerga a linha — e a ausência dela", () => {
  it("CONTROLE: distingue com opt-out, sem opt-out e com signal reutilizado", () => {
    // Sem este caso, um scanner que devolvesse tudo verde (ou nada) passaria
    // como "o repositório está em ordem" — silêncio confundido com veredito.
    const leituras = leiturasMemoizadas(
      fonteDeControle(`
        async function comOptOut() {
          return await createAdminClient()
            .from("platform_branding")
            .select("x")
            .eq("id", 1)
            .abortSignal(new AbortController().signal)
            .maybeSingle();
        }
        async function semOptOut() {
          return await createAdminClient()
            .from("platform_branding")
            .select("x")
            .eq("id", 1)
            .maybeSingle();
        }
        async function comSignalReaproveitado() {
          return await createAdminClient()
            .from("platform_settings")
            .select("x")
            .eq("id", 1)
            .abortSignal(reutilizado.signal)
            .maybeSingle();
        }
      `),
    );

    expect(leituras).toHaveLength(3);
    expect(leituras.filter((l) => l.temOptOut)).toHaveLength(1);
    expect(leituras.find((l) => l.temOptOut)?.tabela).toBe("platform_branding");
    expect(leituras.filter((l) => !l.temOptOut).map((l) => l.tabela)).toEqual([
      "platform_branding",
      "platform_settings",
    ]);
  });

  it("CONTROLE: não confunde o `select` de uma ESCRITA com uma leitura memoizada", () => {
    // A forma de `lib/branding/instalacao.ts` em `semear`: a raiz é a variável do
    // builder da escrita, e o `from`/`select` não são os passos internos — a
    // cerca não pode liberar nem cobrar essa cadeia.
    const leituras = leiturasMemoizadas(
      fonteDeControle(`
        async function semear() {
          const cliente = createAdminClient();
          const consulta = cliente
            .from("platform_branding")
            .update({ app_name: "x" })
            .eq("id", 1);
          return await consulta.select("app_name").maybeSingle();
        }
      `),
    );

    expect(leituras).toHaveLength(0);
  });
});

describe("toda leitura que alimenta memo da instalação carrega o opt-out", () => {
  it.each(SITIOS)("$chave — a leitura de $tabela leva $arquivoDaLeitura", (sitio) => {
    const leituras = leiturasMemoizadas(fonteDoArquivo(sitio.arquivoDaLeitura));
    const leitura = leituras.find((l) => l.tabela === sitio.tabela);

    expect(
      leitura,
      `nenhuma leitura memoizada de ${sitio.tabela} em ${sitio.arquivoDaLeitura}`,
    ).toBeDefined();
    expect(
      leitura?.temOptOut,
      `${sitio.chave}: a leitura de ${sitio.tabela} precisa da linha ${LINHA_ESPERADA}`,
    ).toBe(true);
  });

  it.each(SITIOS)("$chave — o memo protegido tem TTL ou geração", (sitio) => {
    // É o que justifica a linha: sem TTL/geração não há janela para a resposta
    // deduplicada ser memoizada, e a leitura não precisaria do `signal`.
    expect(
      readFileSync(path.join(RAIZ_DO_REPO, sitio.arquivoDoMemo), "utf8"),
      `${sitio.arquivoDoMemo} não declara "${sitio.marcadorDoMemo}"`,
    ).toContain(sitio.marcadorDoMemo);
  });

  it("nenhuma outra leitura memoizada nos mesmos arquivos ficou sem a linha", () => {
    // A varredura global: as 6 cadeias declaradas E qualquer memo novo que
    // apareça nesses arquivos. Contar zero seria instrumento morto, não "tudo em
    // ordem" — por isso a não-vacuidade é assertada junto.
    const arquivos = [...new Set(SITIOS.map((s) => s.arquivoDaLeitura))].sort();
    const todas = arquivos.flatMap((arquivo) =>
      leiturasMemoizadas(fonteDoArquivo(arquivo)).map((leitura) => ({ arquivo, leitura })),
    );

    expect(todas.length, "a varredura não achou nenhuma leitura memoizada").toBeGreaterThanOrEqual(
      SITIOS.length,
    );
    const semLinha = todas
      .filter(({ leitura }) => !leitura.temOptOut)
      .map(({ arquivo, leitura }) => `${arquivo} → ${leitura.tabela}`);
    expect(semLinha, `leituras memoizadas sem ${LINHA_ESPERADA}`).toEqual([]);
  });
});
