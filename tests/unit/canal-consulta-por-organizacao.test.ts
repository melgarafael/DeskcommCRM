import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CHANNEL_SESSION_REF_COLUMNS } from "@/lib/channels/session-ref";

/**
 * VARREDURA: consulta a `channel_sessions` por identificador de PROVIDER tem de
 * levar a organização junto.
 *
 * ─── Por que este arquivo existe (issue #236) ───────────────────────────────
 * Três consultas de `lib/channels/` resolviam uma sessão só pelo identificador
 * do provider (`meta_phone_number_id`, `zernio_account_id`), num client de
 * service role — que **bypassa RLS**. Esse identificador não era único: bastava
 * uma agência conectar a mesma conta em duas organizações (configuração
 * LEGÍTIMA — a rota de conexão exige que a chave informada alcance a conta) para
 * a consulta casar duas linhas. E `maybeSingle()` com duas linhas devolve
 * `data: null` com `error PGRST116` (medido contra @supabase/postgrest-js
 * 2.112.1), não "a primeira linha".
 *
 * Consertar as três instâncias não fecha a classe: o quarto canal chega com o
 * quinto identificador e repete. Esta varredura é o que fecha — e ela deriva as
 * colunas de `CHANNEL_SESSION_REF_COLUMNS`, a MESMA constante que o seam usa
 * para montar o `select`. Canal novo entra na varredura sem ninguém lembrar de
 * editar este arquivo.
 *
 * ─── O escopo é `lib/channels/`, e isso não é arbitrário ────────────────────
 * `docs/doctrine/restricao-de-canal.md` (invariante 1) proíbe nome de provider
 * fora deste diretório, e `pnpm lint:channels` reprova quem tenta — então é aqui
 * que uma resolução por identificador de provider PODE morar. Fora daqui as
 * consultas se resolvem por `id`, por `webhook_path_token` ou por
 * `waha_session_name`, que são UNIQUE no schema (conferido em `baseline.sql`:
 * `channel_sessions_pkey`, `channel_sessions_webhook_path_token_unique`,
 * `channel_sessions_waha_session_name_unique`) — resolução exata por
 * construção, que é a mesma propriedade que a migration 0165 passa a dar aos
 * dois identificadores novos.
 */
const RAIZ = process.cwd();
const DIR = path.join(RAIZ, "lib/channels");

/**
 * As colunas que IDENTIFICAM uma sessão no provider.
 *
 * `provider` sai da lista de propósito: ele é discriminador (qual canal), não
 * identificador (qual sessão) — filtrar por ele nunca pretendeu devolver UMA
 * linha, e cobrá-lo aqui reprovaria consultas corretas como a de
 * `meta/session.ts`, que já resolve por `webhook_path_token`.
 */
const COLUNAS_DE_REF = CHANNEL_SESSION_REF_COLUMNS.split(",")
  .map((c) => c.trim())
  .filter((c) => c !== "provider");

function arquivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return arquivosTs(p);
    return e.isFile() && p.endsWith(".ts") ? [p] : [];
  });
}

interface Consulta {
  arquivo: string;
  /** Função que CONTÉM a cadeia — âncora estável da leitura legítima (a linha anda). */
  funcao: string;
  linha: number;
  /** Filtros da cadeia em si — é onde o escopo de tenant tem de estar. */
  filtros: string[];
  /** Filtros da cadeia MAIS os do terminal. Ver o comentário abaixo. */
  filtrosComTerminal: string[];
}

/** `.eq("x", …)`, `.is(ARCHIVED_AT, null)` → nome da coluna filtrada. */
function colunasFiltradas(trecho: string): string[] {
  return [...trecho.matchAll(/\.(?:eq|is|in|neq|match)\(\s*(?:"([a-z_]+)"|(ARCHIVED_AT))/g)].map(
    (m) => m[1] ?? "archived_at",
  );
}

/**
 * Extrai as consultas a `channel_sessions` e os nomes de coluna filtrados.
 *
 * DOIS recortes, e a diferença não é preguiça de parser — ela espelha como este
 * diretório escreve consulta:
 *
 *   `filtros` vai do `.from("channel_sessions")` até o primeiro `;`, que é o fim
 *   da cadeia. É aí que o escopo de tenant tem de estar, e medir só isto impede
 *   que um `.eq("organization_id", …)` de uma instrução VIZINHA seja contado
 *   como se fosse desta — falso verde é pior que falso vermelho num gate.
 *
 *   `filtrosComTerminal` engloba também a instrução seguinte, e só quando a
 *   cadeia nasce dentro de uma CLOSURE (`const base = (…) => admin.from(…);`).
 *   Esse é o padrão obrigatório de `queryTolerantToMissingArchived`, que precisa
 *   de duas closures porque o cliente do PostgREST é thenable — e é no chamador,
 *   não na closure, que o `.is(ARCHIVED_AT, null)` aparece.
 */
function consultas(fonte: string, arquivo: string): Consulta[] {
  const out: Consulta[] = [];
  const marca = '.from("channel_sessions")';
  let i = fonte.indexOf(marca);
  while (i !== -1) {
    const fim = fonte.indexOf(";", i);
    const cadeia = fonte.slice(i, fim === -1 ? fonte.length : fim);

    const antes = fonte.slice(Math.max(0, i - 200), i);
    const nasceEmClosure = /=\s*\([^)]*\)\s*=>[\s\S]{0,120}$/.test(antes);
    const fim2 = nasceEmClosure && fim !== -1 ? fonte.indexOf(";", fim + 1) : fim;
    const comTerminal = fonte.slice(i, fim2 === -1 ? fonte.length : fim2);

    out.push({
      arquivo: path.relative(RAIZ, arquivo),
      funcao: funcaoQueContem(fonte, i),
      linha: fonte.slice(0, i).split("\n").length,
      filtros: colunasFiltradas(cadeia),
      filtrosComTerminal: colunasFiltradas(comTerminal),
    });
    i = fonte.indexOf(marca, i + marca.length);
  }
  return out;
}

/** Nome da função que CONTÉM a posição `pos` — a âncora das leituras legítimas. */
function funcaoQueContem(fonte: string, pos: number): string {
  const antes = fonte.slice(0, pos);
  const nomes = [...antes.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)];
  return nomes.length > 0 ? nomes[nomes.length - 1]![1]! : "(fora de função)";
}

const TODAS = arquivosTs(DIR).flatMap((a) => consultas(fs.readFileSync(a, "utf8"), a));

/**
 * LEITURAS LEGÍTIMAS — as consultas que ATRAVESSAM organizações DE PROPÓSITO.
 *
 * A regra geral (abaixo) é: quem filtra por identificador de provider filtra
 * `organization_id` também. Existe UMA pergunta no seam que não pode fazer isso
 * sem apagar a proteção que ela mesma implementa — e é por isso que a lista é
 * fechada, com motivo escrito e casamento EXATO (arquivo + função + o conjunto
 * de filtros da cadeia), nunca por "está em tal linha".
 *
 * Quem for acrescentar item aqui precisa responder à pergunta que o motivo de
 * cada um responde: por que filtrar por organização deixaria de cumprir o
 * contrato? Se a resposta for "porque é mais fácil", o item não entra.
 */
const LEITURAS_LEGITIMAS: ReadonlyArray<{
  arquivo: string;
  funcao: string;
  /** O conjunto EXATO de filtros da cadeia. Filtro novo ⇒ a declaração vence. */
  filtros: readonly string[];
  motivo: string;
}> = [
  {
    arquivo: "lib/channels/bot/connect.ts",
    funcao: "roboLigadoEmOutraConexao",
    filtros: ["provider", "telegram_bot_id", "archived_at"],
    motivo:
      "Pergunta feita ANTES do setWebhook: 'este robô já atende por OUTRA conexão " +
      "ativa?'. A resposta é sim/não e nada da outra conexão sai daqui; o ponto " +
      "do contrato é justamente alcançar a conexão de OUTRA organização — o " +
      "mesmo bot conectado por uma agência em duas instalações é configuração " +
      "legítima (é o caso da issue #236). Filtrar por organization_id faria a " +
      "consulta responder 'livre' e o setWebhook trocaria a URL e o segredo de " +
      "quem já atendia: a proteção que existe para não mexer no webhook de " +
      "ninguém passaria a autorizar exatamente isso.",
  },
];

/** A consulta é EXATAMENTE a declarada (arquivo + função + conjunto de filtros)? */
function ehLeituraLegitima(c: Consulta): boolean {
  return LEITURAS_LEGITIMAS.some(
    (l) =>
      l.arquivo === c.arquivo &&
      l.funcao === c.funcao &&
      l.filtros.length === c.filtros.length &&
      l.filtros.every((f) => c.filtros.includes(f)),
  );
}

describe("lib/channels: consulta a channel_sessions por identificador do provider", () => {
  it("a varredura enxerga alguma consulta (senão ela mede o vazio)", () => {
    // Controle do instrumento. Sem isto, renomear a tabela, mover o diretório ou
    // quebrar o extrator deixaria o gate VERDE por não medir nada — o modo de
    // falha que `feedback_instrumento_quebrado_devolve_zero` descreve.
    expect(TODAS.length).toBeGreaterThanOrEqual(5);
    expect(COLUNAS_DE_REF).toContain("meta_phone_number_id");
    expect(COLUNAS_DE_REF).toContain("zernio_account_id");
    expect(COLUNAS_DE_REF).not.toContain("provider");
  });

  it("quem filtra por identificador do provider filtra organization_id também", () => {
    const faltando = TODAS.filter(
      (c) =>
        c.filtros.some((f) => COLUNAS_DE_REF.includes(f)) &&
        !c.filtros.includes("organization_id") &&
        !ehLeituraLegitima(c),
    ).map((c) => `${c.arquivo}:${c.linha} (filtros: ${c.filtros.join(", ") || "nenhum"})`);

    expect(
      faltando,
      "Este client é de service role e BYPASSA RLS. Identificador de provider não é " +
        "único por si só: com duas linhas, maybeSingle() devolve data:null + PGRST116 " +
        "e quem descarta o error cai no fallback do .env — a mensagem sai pela conta " +
        "de outra instalação (issue #236). Resolva o organization_id de fonte " +
        "confiável (sessão, linha já escopada, token do webhook), NUNCA do corpo.",
    ).toEqual([]);
  });

  it("toda leitura legítima declarada casa UMA consulta real que ainda precisa dela", () => {
    // Sem este caso, `LEITURAS_LEGITIMAS` vira porta dos fundos: bastaria
    // declarar arquivo+função inexistentes (ou já escopados) e a regra acima
    // deixaria de olhar a consulta de verdade. É o controle do INSTRUMENTO da
    // exceção, na mesma rodada do veredito.
    const orfas = LEITURAS_LEGITIMAS.filter(
      (l) => TODAS.filter((c) => c.arquivo === l.arquivo && c.funcao === l.funcao).length !== 1,
    ).map((l) => `${l.arquivo}::${l.funcao} (consultas: ${TODAS.filter(
      (c) => c.arquivo === l.arquivo && c.funcao === l.funcao,
    ).length})`);
    expect(orfas, "declaração sem consulta correspondente").toEqual([]);

    const semEfeito = LEITURAS_LEGITIMAS.filter((l) => {
      const c = TODAS.find((x) => x.arquivo === l.arquivo && x.funcao === l.funcao);
      return !c || c.filtros.includes("organization_id") || !ehLeituraLegitima(c);
    }).map((l) => `${l.arquivo}::${l.funcao}`);
    expect(semEfeito, "declaração que não está cobrindo nada (a consulta já filtra organização, ou os filtros mudaram)").toEqual([]);
  });

  it("quem filtra por identificador do provider recorta os ATIVOS", () => {
    // O índice único da migration 0165 é PARCIAL (`where archived_at is null`),
    // pelo precedente da 0107. Consulta que não usa o mesmo recorte lê um
    // conjunto MAIOR do que o que a trava garante — e volta a poder casar duas
    // linhas, justo no ponto em que o banco deixou de proteger.
    const semRecorte = TODAS.filter(
      (c) =>
        c.filtros.some((f) => COLUNAS_DE_REF.includes(f)) &&
        !c.filtrosComTerminal.includes("archived_at"),
    ).map((c) => `${c.arquivo}:${c.linha}`);

    expect(
      semRecorte,
      "Filtre `archived_at is null` (use queryTolerantToMissingArchived, para o " +
        "clone sem a migration 0106 não quebrar): é o MESMO recorte dos índices " +
        "channel_sessions_meta_phone_number_id_ativo_unique e " +
        "channel_sessions_zernio_account_id_ativo_unique.",
    ).toEqual([]);
  });
});

describe("lib/channels: o erro da resolução não pode virar caminho feliz", () => {
  // Descartar o `error` era METADE do defeito: `const { data } = await ...`
  // transforma PGRST116 (duas linhas) em "não tem credencial gravada", e o
  // desfecho é o fallback do env — a ação segue, pela conta errada. Doutrina:
  // falhar FECHADO na ação, ABERTO na informação.
  const fontes = [
    "lib/channels/meta/credentials.ts",
    "lib/channels/zernio/credentials.ts",
    "lib/channels/meta/ingest.ts",
  ];

  for (const rel of fontes) {
    it(`${rel} lê o error da consulta e lança`, () => {
      const fonte = fs.readFileSync(path.join(RAIZ, rel), "utf8");
      expect(fonte).toMatch(/const \{ data, error \} = await queryTolerantToMissingArchived/);
      expect(fonte).toMatch(/if \(error\) \{\s*throw new Error\(/);
    });
  }
});
