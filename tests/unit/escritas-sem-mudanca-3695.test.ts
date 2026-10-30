/**
 * AS DUAS ESCRITAS QUE NÃO ESCREVIAM NADA (#3695).
 *
 * ─── O que a issue mediu numa janela ociosa ─────────────────────────────────
 *
 *   - a cada ~30 s, no Postgres: `update channel_sessions set status = … where
 *     waha_session_name = …` com ZERO linhas (274 vezes em 2h19);
 *   - 1×/min, via PostgREST: `PATCH agent_inbox_items` com a Central VAZIA —
 *     a rodada de `channel-pause-scheduler` é de um minuto e ela fechava o aviso
 *     do agendador mesmo quando não havia aviso nenhum aberto.
 *
 * Nenhuma das duas muda estado: a primeira já trazia `status is distinct from`
 * no `where` (o banco devolvia 0 linhas, mas a instrução era parseada, planejada
 * e varrida), e a segunda fechava um conjunto vazio. Cada uma custa plano,
 * varredura e entrada na trilha de escrita sem carregar informação nenhuma.
 *
 * Os dois casos aqui são de CONTAGEM: com nada a mudar, o número de escritas tem
 * de ser ZERO — e, quando há mudança de verdade, continua sendo exatamente 1.
 * Contar só "houve escrita" deixaria passar a versão antiga do defeito.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { reconcileSessions } from "@/lib/agent-engine/edge/crm/session-reconciler";
import { sincronizarAvisoDoAgendador } from "@/lib/channels/aviso-do-agendador";

const logFake = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const cfg = {
  wahaBaseUrl: "http://waha.local",
  wahaApiKey: "chave",
  intervalMs: 1,
  redriveMinAgeMs: 0,
  redriveBatchSize: 10,
  redriveSpacingMs: 0,
} as never;

/**
 * Pool falso: aplica a regra do `where` na lista em memória e REGISTRA cada
 * instrução. O update de 0 linhas do defeito só é distinguível de um update que
 * mudou algo pelo que o banco devolve — então o fake decide pelos dados.
 */
function poolFalso(inicial: { id: string; status: string }[]) {
  const linhas = inicial.map((l) => ({ ...l }));
  const instrucoes: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    instrucoes.push(sql);
    if (/select cs\.id, cs\.status/i.test(sql)) return { rows: linhas.map((l) => ({ ...l })) };
    if (/update channel_sessions/i.test(sql)) {
      const [, novo] = params as [string, string];
      // `where waha_session_name = $1 and … status is distinct from $2`: sem
      // `is distinct from` no texto, o defeito volta e o caso 4 reprova.
      const temTrava = /status is distinct from \$2/i.test(sql);
      const alvo = temTrava ? linhas.filter((l) => l.status !== novo) : linhas;
      for (const l of alvo) l.status = novo;
      return { rows: alvo.map((l) => ({ id: l.id, status: l.status })) };
    }
    return { rows: [] };
  });
  return { query, instrucoes, linhas };
}

function wahaResponde(sessoes: Array<{ name: string; status: string }>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(sessoes), { status: 200 }));
}

const escritasDeSessao = (instrucoes: string[]) =>
  instrucoes.filter((sql) => /update channel_sessions/i.test(sql));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("channel_sessions: o espelho igual ao WAHA não gera instrução", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("espelho JÁ igual: nenhum UPDATE emitido (antes: 1 instrução por tick, 0 linhas)", async () => {
    wahaResponde([{ name: "s-1", status: "WORKING" }]);
    const banco = poolFalso([{ id: "cs-1", status: "WORKING" }]);

    const corrigidas = await reconcileSessions(banco as unknown as pg.Pool, cfg, logFake as never);

    expect(corrigidas).toBe(0);
    expect(escritasDeSessao(banco.instrucoes)).toEqual([]);
    // O `select` continua: é ele que responde "há o que mudar?".
    expect(banco.instrucoes.some((sql) => /select cs\.id, cs\.status/i.test(sql))).toBe(true);
  });

  it("espelho divergente: exatamente UMA escrita, e o espelho acompanha o WAHA", async () => {
    wahaResponde([{ name: "s-1", status: "WORKING" }]);
    const banco = poolFalso([{ id: "cs-1", status: "STARTING" }]);

    const corrigidas = await reconcileSessions(banco as unknown as pg.Pool, cfg, logFake as never);

    expect(corrigidas).toBe(1);
    expect(escritasDeSessao(banco.instrucoes)).toHaveLength(1);
    expect(banco.linhas[0]?.status).toBe("WORKING");
  });

  it("a trava de corrida fica no `where`: quem mudou a linha entre a leitura e a escrita não é sobrescrito", async () => {
    // O espelho diz STARTING, mas outra instância já gravou WORKING antes de o
    // UPDATE chegar. A trava preserva a corrida; neste caso o fake devolve 0
    // linhas e a rodada não conta como correção feita.
    wahaResponde([{ name: "s-1", status: "WORKING" }]);
    const banco = poolFalso([{ id: "cs-1", status: "STARTING" }]);
    const queryOriginal = banco.query.getMockImplementation()!;
    banco.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/update channel_sessions/i.test(sql)) banco.linhas[0]!.status = "WORKING";
      return queryOriginal(sql, params);
    });

    const corrigidas = await reconcileSessions(banco as unknown as pg.Pool, cfg, logFake as never);

    const escrita = escritasDeSessao(banco.instrucoes)[0] ?? "";
    expect(escrita).toMatch(/status is distinct from \$2/i);
    expect(corrigidas).toBe(0);
  });

  it("sessão STOPPED é retomada e o espelho vira STARTING (uma escrita, como antes)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ name: "s-1", status: "STOPPED" }]), { status: 200 }),
      )
      // O POST /start devolve 200 — a retomada foi aceita.
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const banco = poolFalso([{ id: "cs-1", status: "STOPPED" }]);

    const corrigidas = await reconcileSessions(banco as unknown as pg.Pool, cfg, logFake as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(escritasDeSessao(banco.instrucoes)).toHaveLength(1);
    expect(banco.linhas[0]?.status).toBe("STARTING");
    expect(corrigidas).toBe(1);
  });
});

/**
 * Banco falso da Central: registra toda escrita em `agent_inbox_items` e deixa
 * o teste escolher quantos avisos ABERTOS existem.
 */
function centralFalsa(abertos: number) {
  const escritas: Array<{ tipo: "insert" | "update"; valor: unknown }> = [];
  const leituras: string[] = [];

  function tabela(nome: string) {
    let tipo: "select" | "insert" | "update" = "select";
    let valor: unknown = null;
    const b: Record<string, unknown> = {};
    b.select = (colunas: string) => {
      leituras.push(`${nome}:${colunas}`);
      return b;
    };
    b.eq = () => b;
    b.limit = () => b;
    b.insert = (v: unknown) => {
      tipo = "insert";
      valor = v;
      return b;
    };
    b.update = (v: unknown) => {
      tipo = "update";
      valor = v;
      return b;
    };
    b.then = (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => {
      if (tipo !== "select") escritas.push({ tipo, valor });
      const data =
        nome === "agent_inbox_items"
          ? Array.from({ length: abertos }, (_, i) => ({ id: `aviso-${i}`, organization_id: `org-${i}` }))
          : [{ id: "org-1" }];
      return Promise.resolve({ data, error: null }).then(ok, erro);
    };
    return b;
  }

  return { from: (nome: string) => tabela(nome), escritas, leituras };
}

describe("agent_inbox_items: batida saudável com a Central vazia não escreve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("caixa VAZIA: nenhuma escrita (antes: 1 PATCH por minuto, 0 linhas)", async () => {
    const db = centralFalsa(0);

    await sincronizarAvisoDoAgendador(db as never, { estado: "saudavel" }, logFake as never);

    expect(db.escritas).toEqual([]);
    // A leitura aconteceu — é ela que responde "há o que fechar?".
    expect(db.leituras.some((l) => l.startsWith("agent_inbox_items:id"))).toBe(true);
  });

  it("com aviso ABERTO: exatamente um update, resolvendo (o laço de retorno continua)", async () => {
    const db = centralFalsa(1);

    await sincronizarAvisoDoAgendador(db as never, { estado: "saudavel" }, logFake as never);

    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]).toMatchObject({ tipo: "update", valor: { status: "resolved" } });
  });

  it("leitura da Central que falha não derruba a batida: só warn (best-effort)", async () => {
    const db = {
      from: () => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.limit = () => b;
        b.then = (ok?: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: "Central fora" } }).then(ok, erro);
        return b;
      },
    };

    await expect(
      sincronizarAvisoDoAgendador(db as never, { estado: "saudavel" }, logFake as never),
    ).resolves.toBeUndefined();
    expect(logFake.warn).toHaveBeenCalled();
  });
});
