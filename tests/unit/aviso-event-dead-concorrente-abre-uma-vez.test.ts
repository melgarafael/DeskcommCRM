/**
 * DOIS DRENOS LEEM "NÃO EXISTE" NO MESMO INSTANTE — E ABREM UM AVISO SÓ.
 *
 * Issue #880. O aviso `event_dead` da Central é deduplicado por organização, e
 * a deduplicação era uma PERGUNTA seguida de uma ESCRITA: `avisarEventoMorto`
 * (`lib/event-log/drain.ts`) consulta se já existe um aberto e só então insere.
 * O cron `event-log-drain` e o drain-loop do worker chamam `drainEventLog` ao
 * mesmo tempo, e o `insert … where not exists` de `insertInboxItem`
 * (`lib/agent-engine/db/repository.ts`) juntava as duas numa instrução só — mas
 * sem índice nenhum que sustentasse a condição. Os dois leem "não existe"
 * antes de qualquer escrita e os dois inserem: dois avisos idênticos para o
 * mesmo problema.
 *
 * O que este arquivo mede, e por que entra por aqui:
 *
 *   1. A GARANTIA ESTÁ NO BANCO. Os índices únicos desta tabela são LIDOS do
 *      SQL do repositório (migrations + baseline) e é essa leitura que decide
 *      se o dublê recusa a segunda linha. Sem a migration 0491 não há índice,
 *      o dublê aceita as duas e o caso abaixo fica vermelho — é ele que prende
 *      a corrida.
 *   2. A corrida em si, com as DUAS escritas disparadas juntas: os dois
 *      `where not exists` são avaliados contra a tabela ainda vazia (é o que o
 *      Postgres faz — cada instrução tem o seu snapshot), e só depois a linha
 *      da primeira aterra.
 *   3. O `23505` é DESFECHO NORMAL nos dois caminhos de escrita: devolve
 *      `null`, não lança, não loga erro.
 *   4. O que NÃO pode regredir: kinds diferentes em paralelo, as duas famílias
 *      do `event_dead` abertas ao mesmo tempo e a REABERTURA de um aviso
 *      resolvido (o predicado é parcial justamente para isso).
 *
 *     npx vitest run tests/unit/aviso-event-dead-concorrente-abre-uma-vez.test.ts
 *
 * O que este arquivo NÃO mede: a corrida contra o Postgres de verdade, com duas
 * transações. Isso é `tests/invariants/` (suite `pnpm test:db`), que aplica o
 * `supabase/baseline.sql` inteiro.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { insertInboxItem } from "@/lib/agent-engine/db/repository";
import { avisarEventoMorto } from "@/lib/event-log/drain";
import { logger } from "@/lib/logger";

const ORG = "ed000000-0000-4000-8000-000000000880";
const OUTRA_ORG = "ed000000-0000-4000-8000-000000000881";
const EVENTO = {
  id: "ev-880",
  organization_id: ORG,
  event_type: "media.derive_requested",
  attempts: 4,
};

// ─── O SQL DO REPOSITÓRIO É A FONTE DA GARANTIA ──────────────────────────────
//
// Ler os índices do próprio SQL (e não de uma lista escrita à mão) é o que faz
// o caso 1 significar alguma coisa: se a migration sumir, some a lista, o dublê
// deixa de recusar e o teste fica vermelho. Uma lista em mãos passaria com o
// banco sem índice nenhum.

interface IndiceUnico {
  nome: string;
  colunas: string[];
  /** Pares `coluna = 'literal'` do predicado — `status = 'open'` etc. */
  condicoes: [string, string][];
}

interface Linha {
  organization_id: string | null;
  kind: string;
  title: string;
  status: string;
  severity?: string;
  body?: string | null;
  ref_kind?: string | null;
  ref_id?: string | null;
  [chave: string]: unknown;
}

/**
 * O que o dreno manda de fato — `status` NÃO vem daqui, ele nasce do DEFAULT da
 * coluna, e é justamente por isso que o predicado do índice pode ser sobre ele.
 * (`Omit<Linha, "status">` não serve: `Linha` tem assinatura de índice e o
 * `Omit` devolve só ela, sem as colunas.)
 */
interface LinhaEnviada {
  organization_id: string | null;
  kind: string;
  severity?: string;
  title: string;
  body?: string | null;
  ref_kind?: string | null;
  ref_id?: string | null;
  status?: string;
}

// Memoizado: são ~480 arquivos de SQL (migrations + baseline) e cada caso usa o
// resultado — reler a cadeia inteira por caso só deixaria o arquivo lento.
let CACHED_SQL: string | null = null;

function sqlDoBanco(): string {
  if (CACHED_SQL !== null) return CACHED_SQL;
  const supabase = join(process.cwd(), "supabase");
  const cadeia = readdirSync(join(supabase, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(supabase, "migrations", f), "utf8"))
    .join("\n");
  const baseline = readFileSync(join(supabase, "baseline.sql"), "utf8");
  CACHED_SQL = `${cadeia}\n${baseline}`;
  return CACHED_SQL;
}

let CACHED_INDICES: IndiceUnico[] | null = null;

/**
 * Predicado restrito a `col = 'literal'` ligados por `and` — é a forma de toda
 * condição parcial desta tabela. Cláusula que não casar cancela o índice inteiro
 * (dublê que não entende a condição não pode fingir que aplicou).
 */
function lerCondicoes(texto: string | undefined): [string, string][] | null {
  if (texto === undefined) return [];
  const partes = texto.split(/\s+and\s+/i);
  const pares: [string, string][] = [];
  for (const parte of partes) {
    const m = /^\s*([a-z_]+)\s*=\s*'([^']*)'\s*$/i.exec(parte);
    if (!m || m[1] === undefined || m[2] === undefined) return null;
    pares.push([m[1], m[2]]);
  }
  return pares;
}

function indicesUnicosDeAviso(): IndiceUnico[] {
  if (CACHED_INDICES !== null) return CACHED_INDICES;
  const re =
    /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on\s+(?:public\.)?agent_inbox_items\s*\(([^)]*)\)\s*(?:where\s+([^;]+))?/gi;
  const porNome = new Map<string, IndiceUnico>();
  for (const m of sqlDoBanco().matchAll(re)) {
    const nome = m[1];
    const colunas = (m[2] ?? "")
      .split(",")
      .map((c) => c.trim().replace(/^public\./, ""))
      .filter((c) => c.length > 0);
    const condicoes = lerCondicoes(m[3]);
    if (nome === undefined || colunas.length === 0 || condicoes === null) continue;
    porNome.set(nome, { nome, colunas, condicoes });
  }
  CACHED_INDICES = [...porNome.values()];
  return CACHED_INDICES;
}

/** O que o Postgres faria ao indexar a linha: predicado na chave, e `null` fora. */
function indiceQueBarra(indices: IndiceUnico[], linhas: Linha[], nova: Linha): string | null {
  for (const indice of indices) {
    if (!indice.condicoes.every(([c, v]) => nova[c] === v)) continue;
    const chave = indice.colunas.map((c) => nova[c] ?? null);
    if (chave.some((k) => k === null)) continue; // Postgres: NULLS DISTINCT
    const igual = linhas.find(
      (l) =>
        indice.condicoes.every(([c, v]) => l[c] === v) &&
        indice.colunas.every((c, i) => (l[c] ?? null) === chave[i]),
    );
    if (igual !== undefined) return indice.nome;
  }
  return null;
}

function colisao(nome: string): Error {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${nome}"`),
    { code: "23505" },
  );
}

// ─── DUBLÊ 1: o caminho do supabase-js (lib/event-log/drain.ts) ──────────────

interface CadeiaDeLeitura {
  eq(coluna: string, valor: unknown): CadeiaDeLeitura;
  neq(coluna: string, valor: unknown): CadeiaDeLeitura;
  limit(n: number): CadeiaDeLeitura;
  maybeSingle(): Promise<{ data: Linha | null; error: null }>;
}

function cadeia(linhas: Linha[]): CadeiaDeLeitura {
  const filtros: [string, unknown, boolean][] = [];
  const q: CadeiaDeLeitura = {
    eq: (coluna, valor) => {
      filtros.push([coluna, valor, false]);
      return q;
    },
    neq: (coluna, valor) => {
      filtros.push([coluna, valor, true]);
      return q;
    },
    limit: () => q,
    // O snapshot é AQUI, na avaliação da instrução — como no Postgres. Sem isto a
    // segunda chamada enxergaria a linha que a primeira acabou de gravar e a
    // corrida deixaria de existir.
    maybeSingle: () =>
      Promise.resolve({
        data:
          linhas.find((l) =>
            filtros.every(([c, v, negado]) => (negado ? l[c] !== v : l[c] === v)),
          ) ?? null,
        error: null,
      }),
  };
  return q;
}

function adminComOsIndicesDoRepositorio(linhas: Linha[] = []) {
  const indices = indicesUnicosDeAviso();
  const admin = {
    from(tabela: string) {
      if (tabela !== "agent_inbox_items") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select: () => cadeia(linhas),
        // `status` vem do DEFAULT da coluna no Postgres — o dreno não o manda.
        insert: async (recebida: LinhaEnviada) => {
          const nova: Linha = {
            organization_id: recebida.organization_id,
            kind: recebida.kind,
            severity: recebida.severity ?? "warn",
            title: recebida.title,
            body: recebida.body ?? null,
            ref_kind: recebida.ref_kind ?? null,
            ref_id: recebida.ref_id ?? null,
            status: recebida.status ?? "open",
          };
          const conflitante = indiceQueBarra(indices, linhas, nova);
          if (conflitante !== null) return { error: { code: "23505", message: `duplicate key value violates unique constraint "${conflitante}"` }, data: null };
          linhas.push(nova);
          return { error: null, data: [nova] };
        },
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, linhas, indices };
}

// ─── DUBLÊ 2: o caminho do pg (insertInboxItem) ──────────────────────────────
//
// `where not exists` avaliado no COMEÇO da instrução, a linha aterrando DEPOIS:
// é a mesma janela que o Postgres abre entre uma instrução e outra, e é ela que
// os dois `insertInboxItem` simultâneos atravessam.

function poolComOsIndicesDoRepositorio(linhas: Linha[] = []) {
  const indices = indicesUnicosDeAviso();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (!sql.includes("insert into agent_inbox_items")) return { rows: [] };
    const [org, kind, severity, title, body, refKind, refId, usaRef, usaTitulo] = params;
    const nova: Linha = {
      organization_id: (org as string | null) ?? null,
      kind: kind as string,
      severity: severity as string,
      title: title as string,
      body: (body as string | null) ?? null,
      ref_kind: (refKind as string | null) ?? null,
      ref_id: (refId as string | null) ?? null,
      status: "open",
    };
    const mesmoValor = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
    const jaExiste = linhas.some(
      (l) =>
        mesmoValor(l.organization_id, nova.organization_id) &&
        l.kind === nova.kind &&
        l.status === "open" &&
        (usaRef !== true || (mesmoValor(l.ref_kind, nova.ref_kind) && mesmoValor(l.ref_id, nova.ref_id))) &&
        (usaTitulo !== true || l.title === nova.title),
    );
    if (jaExiste) return { rows: [] };
    // A escrita aterra só depois de ceder o turno — é a corrida.
    await Promise.resolve();
    const conflitante = indiceQueBarra(indices, linhas, nova);
    if (conflitante !== null) throw colisao(conflitante);
    linhas.push(nova);
    return { rows: [nova] };
  });
  return { pool: { query } as unknown as pg.Pool, linhas, indices, query };
}

const SEMANTICO = "Uma tarefa automática parou de tentar";

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

describe("a garantia do dedupe de `event_dead` mora no banco", () => {
  it("a tripla da doutrina está na árvore: migration, apêndice do baseline e linha no MANIFEST", () => {
    const indices = indicesUnicosDeAviso();
    expect(
      indices.find((i) => i.nome === "agent_inbox_event_dead_aberto_unico"),
      "índice único parcial ausente das migrations/baseline — sem ele a corrida continua aberta (issue #880)",
    ).toEqual({
      nome: "agent_inbox_event_dead_aberto_unico",
      colunas: ["organization_id", "kind", "title"],
      condicoes: [
        ["status", "open"],
        ["kind", "event_dead"],
      ],
    });

    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    expect(baseline, "o apêndice do baseline não carrega o índice — self-host não o teria").toContain(
      "agent_inbox_event_dead_aberto_unico",
    );

    const manifest = readFileSync(
      join(process.cwd(), "supabase", "migrations", "MANIFEST.md"),
      "utf8",
    );
    expect(manifest).toContain("0491_dedupe_de_event_dead_atomico");
  });

  it("o caso que prende: dois drenos juntos abrem UM aviso, e ninguém loga erro", async () => {
    const { admin, linhas } = adminComOsIndicesDoRepositorio();

    await Promise.all([
      avisarEventoMorto(admin, EVENTO, "derivação não voltou em 10 min"),
      avisarEventoMorto(admin, EVENTO, "derivação não voltou em 10 min"),
    ]);

    expect(linhas, "dois drenos leram 'não existe' juntos e os dois inseriram").toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      organization_id: ORG,
      kind: "event_dead",
      severity: "critical",
      title: SEMANTICO,
      status: "open",
    });
    // Quem chega segundo recebe `23505` — é o banco dizendo "já estava aberto",
    // não uma falha do dreno.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("o 23505 é desfecho normal em `insertInboxItem`: devolve `null`, não lança", async () => {
    const { pool, linhas } = poolComOsIndicesDoRepositorio();

    const [a, b] = await Promise.all([
      insertInboxItem(pool, ORG, { kind: "event_dead", title: SEMANTICO, severity: "critical" }, "kind_e_titulo"),
      insertInboxItem(pool, ORG, { kind: "event_dead", title: SEMANTICO, severity: "critical" }, "kind_e_titulo"),
    ]);

    expect(linhas, "os dois passaram pelo `where not exists` e o índice não barrou").toHaveLength(1);
    expect([a, b].filter((r) => r !== null), "quem perdeu a corrida devolve a linha de novo").toHaveLength(1);
    expect([a, b].filter((r) => r === null), "quem perdeu devolve `null`, como o contrato manda").toHaveLength(1);
  });
});

describe("o que o índice novo NÃO pode levar junto", () => {
  it("kinds diferentes seguem gravando em paralelo, cada um no seu lugar", async () => {
    const { pool, linhas } = poolComOsIndicesDoRepositorio();

    await Promise.all([
      insertInboxItem(pool, ORG, { kind: "event_dead", title: SEMANTICO, severity: "critical" }, "kind_e_titulo"),
      insertInboxItem(pool, ORG, { kind: "budget_exceeded", title: "Teto de orçamento estourado" }, "kind"),
      insertInboxItem(pool, OUTRA_ORG, { kind: "event_dead", title: SEMANTICO, severity: "critical" }, "kind_e_titulo"),
    ]);

    expect(linhas.map((l) => `${l.organization_id}/${l.kind}`).sort()).toEqual([
      `${ORG}/budget_exceeded`,
      `${ORG}/event_dead`,
      `${OUTRA_ORG}/event_dead`,
    ]);
  });

  it("as duas famílias do `event_dead` continuam abertas juntas na mesma organização", async () => {
    const { admin, linhas } = adminComOsIndicesDoRepositorio();

    // O da IA que deixou de responder (título fixo da família) e o de mídia —
    // o índice só barra o MESMO título, porque (organização, kind) sozinho
    // calaria um pelo outro (`aviso-de-evento-morto.ts`, "as duas famílias").
    linhas.push({
      organization_id: ORG,
      kind: "event_dead",
      title: "A IA deixou de responder uma mensagem de cliente",
      status: "open",
    });

    await avisarEventoMorto(admin, EVENTO, "derivação não voltou em 10 min");

    expect(linhas).toHaveLength(2);
    expect(linhas.filter((l) => l.status === "open")).toHaveLength(2);
  });

  it("reabrir um aviso resolvido continua passando — o predicado é parcial", async () => {
    const { pool, linhas } = poolComOsIndicesDoRepositorio([
      {
        organization_id: ORG,
        kind: "event_dead",
        title: SEMANTICO,
        status: "resolved",
      },
    ]);

    // Se `status` estivesse na CHAVE, a linha resolvida ocuparia o slot para
    // sempre e o `PATCH /api/v1/ai/inbox/[id]` (reabrir) morreria no segundo
    // ciclo. No índice parcial ela sai de lá quando resolve.
    const reaberto = await insertInboxItem(
      pool,
      ORG,
      { kind: "event_dead", title: SEMANTICO, severity: "critical" },
      "kind_e_titulo",
    );

    expect(reaberto, "a linha resolvida segurou a nova abertura — reabertura quebrada").not.toBeNull();
    expect(linhas.map((l) => l.status).sort()).toEqual(["open", "resolved"]);
  });

  it("o dublê enxerga os índices de verdade (controle do instrumento)", () => {
    const { indices } = adminComOsIndicesDoRepositorio();
    expect(indices.length, "nenhum índice único de `agent_inbox_items` no SQL — regex quebrada?").toBeGreaterThan(
      0,
    );
    expect(indices.map((i) => i.nome)).toContain("agent_inbox_routing_unique");
  });
});
