/**
 * A CLASSE DO `Date` × `string` — a régua que lê coluna de data e decide por TIPO.
 *
 * O caso de origem (#3846): `midiaDerivavelPendente` respondia "nada pendente"
 * CONTRA POSTGRES DE VERDADE, porque exigia `typeof quando === "string"` e o
 * driver `pg` entrega `timestamptz` como `Date`. Os dublês de pool devolvem
 * string, então nenhum teste de unidade via — a guarda do #3841 ficou inerte em
 * produção até alguém medir com banco real (#3845/#3849).
 *
 * Aquele não era um caso isolado, era a CLASSE. Esta cerca não guarda um arquivo:
 * varre a árvore inteira e reprova a FORMA, em três decisões:
 *
 *   1. `typeof <coluna de data> === "string"` (ou `!==`) decidindo o fluxo num
 *      arquivo que consulta o driver com SQL cru (`.query(`) — é o molde exato do
 *      defeito: certo para PostgREST/`jsonb`, inerte para `pg`;
 *   2. `Date.parse(<coluna de data>)` no mesmo tipo de arquivo — a outra metade
 *      da classe: sobre um `Date` devolve `NaN`, e `NaN` não é maior nem menor
 *      que nada, então toda comparação vira `false` EM SILÊNCIO;
 *   3. e as duas saídas legítimas, que a cerca reconhece sozinha:
 *      · o arquivo trata as DUAS formas do mesmo nome (`x instanceof Date`
 *        presente) — é o conserto do #3846;
 *      · a consulta já normaliza na borda (`starts_at::text`, `to_char(...)`).
 *
 * ─── Por que lista CONGELADA, e não zero-tolerância ──────────────────────────
 *
 * Sobra um punhado de decisões por `typeof` que estão CERTAS: o valor vem de
 * `jsonb`, de payload de webhook ou de um histórico já normalizado na leitura do
 * contexto. Elas entram em `DEVIDAS` com o motivo escrito, no padrão do
 * repositório (`MIGRATIONS_QUE_NAO_RODAM`, `DIVERGENCIAS_CONGELADAS`) e com
 * cobrança nos DOIS sentidos:
 *
 *   · decisão nova fora da lista → REPROVA (é a classe voltando);
 *   · entrada cuja decisão deixou de existir → REPROVA com "dívida paga: remova a
 *     entrada" (senão a lista vira cemitério e esconde a próxima).
 *
 * ─── O que a cerca NÃO é ─────────────────────────────────────────────────────
 *
 * Não é prova de runtime: quem prova que a régua VÊ o que o driver entrega é o
 * invariante de banco (`tests/invariants/data-do-banco-nao-vem-como-texto.test.ts`,
 * `pnpm test:db`). Esta peça é a catraca estática — barata, roda em `pnpm cercas`
 * e pega o caso novo no commit, não na madrugada em produção.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();

/** Onde mora código de produção. `tests/` fica de fora: lá a string é o dado. */
const DIRETORIOS = ["lib", "app", "workers", "scripts", "hooks", "components"];

/**
 * Nome de coluna de data. A lista é de SUFIXOS/prefixos do schema
 * (`supabase/baseline.sql`), não de variáveis: `sent_at`, `created_at`,
 * `run_after`, `paused_until`, `expira_em`, `opened_at`… mais os nomes que o
 * repositório dá ao instante quando o alias já perdeu a coluna (`quando`,
 * `instante`, `nascimento`).
 */
const NOME_DE_DATA =
  /(?:^|_)(?:at|on|em|ate|until|after|since)(?:_|$)|(?:^|_)(?:expira|prazo|quando|instante|nascimento|venc)|(?:^|_)(?:created|updated|sent|started|finished|opened|closed|resolved|paused|archived|deleted|scheduled|start|end)(?:_|$)/i;

/** Arquivo que fala com o driver por SQL cru — a origem `Date` da classe. */
const CONSULTA_SQL = /\.query\s*(?:<|\()/;

type Achado = { arquivo: string; linha: number; nome: string; forma: "typeof" | "parse" };

/**
 * A entrada congelada: uma decisão por `typeof`/`Date.parse` que está CERTA, com
 * o motivo medido. `nome` é o último pedaço da expressão (`abertura.sent_at` →
 * `sent_at`), para a entrada sobreviver a renomear a variável local.
 */
type Devida = { arquivo: string; nome: string; motivo: string };

const DEVIDAS: readonly Devida[] = [
  {
    arquivo: "lib/agent-engine/agent/human-handoff.ts",
    nome: "sent_at",
    motivo:
      "o histórico chega pelo contrato `MensagemDoHistorico` (sent_at?: string) e é normalizado na LEITURA do contexto (`get-lead-context.ts`, isoLocalComOffset) — o `typeof` é defensivo contra fixture sem relógio, não decisão sobre o transporte",
  },
  {
    arquivo: "lib/escalacao/handoff-tecnico.ts",
    nome: "marcado_em",
    motivo:
      "`conversations.metadata` é jsonb escrito por `JSON.stringify` neste processo: a data É string por construção, e o campo ausente é o caso normal (marca antiga)",
  },
  {
    arquivo: "lib/escalacao/handoff-tecnico.ts",
    nome: "resolvido_em",
    motivo:
      "mesma coluna jsonb do irmão acima; `typeof === 'string'` é a régua de presença da marca, não de transporte",
  },
  {
    arquivo: "lib/agent-engine/agent/followup-turn.ts",
    nome: "sent_at",
    motivo:
      "`context.messages` vem de `get-lead-context.ts`, que entrega `sent_at` já em ISO com offset (`isoLocalComOffset`); o `Date.parse` consome o contrato de string dessa borda, não a coluna",
  },
  {
    arquivo: "workers/ai-sentiment-worker.pedidos.ts",
    nome: "bot_silenced_until",
    motivo:
      "leitura por PostgREST (`.from(\"conversations\").select(...)`), que serializa `timestamptz` em string; `'infinity'` é tratado à parte porque o PostgREST o devolve como literal",
  },
  {
    arquivo: "workers/ai-sentiment-worker.pedidos.ts",
    nome: "last_handoff_at",
    motivo: "mesma leitura PostgREST do irmão acima",
  },
  {
    arquivo: "lib/agent-engine/guardrails/lgpd/legal-basis.ts",
    nome: "granted_at",
    motivo:
      "`contacts.consent` é jsonb e o carimbo é escrito pelo próprio app (`{marketing: {granted_at, …}}`): string é a forma única ali, e o teste é de PRESENÇA do consentimento, não de transporte",
  },
];

function arquivosDeCodigo(dir: string): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === "node_modules") continue;
      saida.push(...arquivosDeCodigo(caminho));
      continue;
    }
    if (!/\.tsx?$/.test(entrada.name)) continue;
    if (entrada.name.endsWith(".test.ts") || entrada.name.endsWith(".test.tsx")) continue;
    if (entrada.name.endsWith(".d.ts")) continue;
    saida.push(caminho);
  }
  return saida;
}

/** `abertura.sent_at` → `sent_at`; `quando` → `quando`; `r["sent_at"]` → `sent_at`. */
function nomeDoAlvo(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression)) {
    return expr.argumentExpression.text;
  }
  return null;
}

/**
 * O detector, puro sobre o texto — é o mesmo caminho para a árvore do repo e para
 * o caso sintético do último `it` (que prova que ele TEM dentes, sem depender de
 * o repositório continuar tendo um defeito).
 */
export function varrer(arquivo: string, fonte: string): { achados: Achado[]; excecoes: string[] } {
  const sf = ts.createSourceFile(arquivo, fonte, ts.ScriptTarget.ES2022, true);
  const achados: Achado[] = [];
  /** Nomes que o arquivo trata nas DUAS formas (o conserto do #3846). */
  const trataAsDuas = new Set<string>();
  /** Nomes que a consulta já normaliza (`x::text`, `to_char(x`, `x::date`). */
  const normalizadosNaConsulta = new Set<string>();
  const normalizador = /\b([a-z_][a-z0-9_]*)\s*::\s*(?:text|date)\b|\bto_char\s*\(\s*([a-z_][a-z0-9_]*)/gi;
  // Sem comentários: um `// sent_at::text` explicando o passado isentaria a
  // decisão viva — a sonda contaria o próprio comentário.
  const semComentarios = ts.createPrinter({ removeComments: true }).printFile(sf);
  for (const m of semComentarios.matchAll(normalizador)) {
    const nome = m[1] ?? m[2];
    if (nome !== undefined) normalizadosNaConsulta.add(nome.toLowerCase());
  }

  const visitar = (no: ts.Node): void => {
    // `x instanceof Date` — a outra metade da régua.
    if (
      ts.isBinaryExpression(no) &&
      no.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(no.right) &&
      no.right.text === "Date"
    ) {
      const nome = nomeDoAlvo(no.left);
      if (nome !== null) trataAsDuas.add(nome);
    }

    if (ts.isBinaryExpression(no)) {
      const op = no.operatorToken.kind;
      const ehIgualdade =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if (
        ehIgualdade &&
        ts.isTypeOfExpression(no.left) &&
        (ts.isStringLiteral(no.right) || ts.isNoSubstitutionTemplateLiteral(no.right)) &&
        no.right.text === "string"
      ) {
        const nome = nomeDoAlvo(no.left.expression);
        if (nome !== null && NOME_DE_DATA.test(nome)) {
          const { line } = sf.getLineAndCharacterOfPosition(no.getStart(sf));
          achados.push({ arquivo, linha: line + 1, nome, forma: "typeof" });
        }
      }
    }

    // `Date.parse(<coluna>)` — `NaN` silencioso em cima de um `Date`.
    if (
      ts.isCallExpression(no) &&
      ts.isPropertyAccessExpression(no.expression) &&
      ts.isIdentifier(no.expression.expression) &&
      no.expression.expression.text === "Date" &&
      no.expression.name.text === "parse" &&
      no.arguments.length > 0
    ) {
      const nome = nomeDoAlvo(no.arguments[0]!);
      if (nome !== null && NOME_DE_DATA.test(nome)) {
        const { line } = sf.getLineAndCharacterOfPosition(no.getStart(sf));
        achados.push({ arquivo, linha: line + 1, nome, forma: "parse" });
      }
    }

    ts.forEachChild(no, visitar);
  };
  visitar(sf);

  const excecoes = [...trataAsDuas, ...normalizadosNaConsulta];
  return {
    achados: achados.filter((a) => !excecoes.includes(a.nome)),
    excecoes,
  };
}

type Violacao = { chave: string; linhas: number[] };

function chave(a: { arquivo: string; nome: string }): string {
  return `${a.arquivo}|${a.nome}`;
}

function violacoesDaArvore(): { violacoes: Violacao[]; analisados: number; comSql: number } {
  const porChave = new Map<string, number[]>();
  let analisados = 0;
  let comSql = 0;
  for (const dir of DIRETORIOS) {
    for (const caminho of arquivosDeCodigo(dir)) {
      const arquivo = caminho.split(sep).join("/");
      const fonte = readFileSync(join(RAIZ, caminho), "utf8");
      analisados += 1;
      if (!CONSULTA_SQL.test(fonte)) continue;
      comSql += 1;
      for (const a of varrer(arquivo, fonte).achados) {
        porChave.set(chave(a), [...(porChave.get(chave(a)) ?? []), a.linha]);
      }
    }
  }
  return {
    violacoes: [...porChave.entries()].map(([k, linhas]) => ({ chave: k, linhas })),
    analisados,
    comSql,
  };
}

describe("a classe do Date × string: quem lê coluna de data não decide por tipo", () => {
  const { violacoes, analisados, comSql } = violacoesDaArvore();
  const encontradas = new Set(violacoes.map((v) => v.chave));
  const congeladas = new Set(DEVIDAS.map(chave));

  it("o scanner olha a árvore de verdade (não é verde por vacuidade)", () => {
    expect(analisados).toBeGreaterThan(500);
    // Arquivo que consulta o driver por SQL cru: é onde a classe mora.
    expect(comSql).toBeGreaterThan(50);
  });

  it("decisão por `typeof`/`Date.parse` em arquivo que lê o banco está na lista congelada", () => {
    const novas = violacoes.filter((v) => !congeladas.has(v.chave));
    expect(
      novas.map((v) => `${v.chave} (linha ${v.linhas.join(", ")})`),
      "decisão de data por tipo numa leitura do driver `pg` — o valor chega como `Date` e a régua fica inerte. " +
        "Normalize na borda com `instanteDoBanco` (`lib/tempo/agora.ts`) e trate as DUAS formas; " +
        "se a origem for PostgREST/jsonb, congele a entrada em DEVIDAS com o motivo medido.",
    ).toEqual([]);
  });

  it("entrada congelada que deixou de divergir reprova: dívida paga, remova a entrada", () => {
    const pagas = DEVIDAS.filter((d) => !encontradas.has(chave(d))).map((d) => chave(d));
    expect(pagas, "o motivo desta entrada não vale mais — apague a linha de DEVIDAS").toEqual([]);
  });

  it("o detector tem dentes: reprova o molde do #3846 num arquivo que lê o banco", () => {
    const antigo = `
      const { rows } = await pool.query("select created_at from messages");
      const quando = rows[0].created_at;
      if (typeof quando === "string") return new Date(quando).getTime();
      return null;
    `;
    const achado = varrer("lib/exemplo.ts", antigo).achados;
    expect(achado.map((a) => `${a.nome}:${a.forma}`)).toEqual(["quando:typeof"]);

    const consertado = `
      const { rows } = await pool.query("select created_at from messages");
      const quando = rows[0].created_at;
      if (typeof quando === "string") return new Date(quando).getTime();
      if (quando instanceof Date) return quando.getTime();
      return null;
    `;
    expect(varrer("lib/exemplo.ts", consertado).achados).toEqual([]);

    const parseado = `
      const { rows } = await pool.query("select sent_at from messages");
      const t = Date.parse(rows[0].sent_at);
    `;
    expect(varrer("lib/exemplo.ts", parseado).achados.map((a) => a.forma)).toEqual(["parse"]);

    // O comentário não isenta: só o SQL de verdade (`created_at::text`) normaliza.
    const comentado = `// a versão antiga lia quando::text\n${antigo}`;
    expect(varrer("lib/exemplo.ts", comentado).achados.map((a) => a.nome)).toEqual(["quando"]);
  });

  it("o detector não confunde e-mail, emoji ou `atual` com coluna de data", () => {
    const legitimo = `
      const { rows } = await pool.query("select email from contacts");
      const r = rows[0];
      if (typeof r.email === "string" && typeof r.emoji === "string" && typeof atual === "string") {}
      if (typeof ate === "string") {}
    `;
    expect(varrer("lib/exemplo.ts", legitimo).achados.map((a) => a.nome)).toEqual(["ate"]);
  });
});
