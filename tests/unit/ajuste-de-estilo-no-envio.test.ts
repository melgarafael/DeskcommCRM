import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { runBeforeSend, type RunBeforeSendArgs } from "@/lib/agent-engine/guardrails/before-send";

/**
 * O AJUSTE DE ESTILO CHEGA AO TEXTO QUE SAI — E DEIXA RASTRO (#378, PR #1139).
 *
 * Os testes do PR mediam a função pura (`removerTravessaoLongo`) e a POSIÇÃO das
 * linhas no arquivo (`indexOf`). Nenhum rodava o `runBeforeSend`, então nada
 * provava as três coisas que o operador sente:
 *
 *   1. o corpo que chega ao canal é o reescrito — não o do modelo;
 *   2. a leitura da preferência acontece ANTES do `begin`. Dentro da transação,
 *      uma consulta que falha a deixa abortada e a PRÓXIMA morre com 25P02 —
 *      longe daqui e com outro nome;
 *   3. a reescrita entra no trace. Mudar o texto que o cliente lê sem registro
 *      é o tipo de coisa que ninguém consegue auditar depois.
 *
 * A bancada é a mesma de `espera-humana-fora-do-lock-do-numero.test.ts`: pool
 * falso que registra a ORDEM dos eventos.
 */

type Eventos = string[];

/**
 * Pool falso. `respostaDoEstilo` é o que a consulta de `org_guardrail_layers`
 * devolve; `falharNoEstilo` faz ela estourar, que é o caso do item 2.
 */
function poolFalso(
  eventos: Eventos,
  opcoes: { ligado?: boolean; falharNoEstilo?: boolean } = {},
) {
  const client = {
    query: vi.fn(async (sql: string): Promise<{ rows: unknown[] }> => {
      const s = String(sql).toLowerCase().trim();
      if (s.includes("org_guardrail_layers")) {
        eventos.push("le_estilo");
        if (opcoes.falharNoEstilo === true) throw new Error("db indisponível");
        return {
          rows:
            opcoes.ligado === true
              ? [{ layer: "estilo:sem_travessao_longo", enabled: true }]
              : [],
        };
      }
      if (s.includes("pg_advisory_xact_lock")) eventos.push("lock");
      if (s === "begin") eventos.push("begin");
      if (s === "commit") eventos.push("commit");
      if (s === "rollback") eventos.push("rollback");
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => {
      eventos.push("connect");
      return client;
    }),
    query: vi.fn().mockResolvedValue({ rows: [{ id: "trace-1" }] }),
  };
  return { pool: pool as unknown as pg.Pool, client };
}

function argsDoTurno(pool: pg.Pool, extras: Partial<RunBeforeSendArgs> = {}): RunBeforeSendArgs {
  return {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: "00000000-0000-4000-8000-000000000001",
    leadId: "00000000-0000-4000-8000-000000000002",
    jobId: "00000000-0000-4000-8000-000000000003",
    channelSessionId: "00000000-0000-4000-8000-000000000004",
    body: "Olá — segue o orçamento",
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date("2026-09-19T12:00:00.000Z"),
    rng: () => 0,
    sleep: async () => {},
    gates: [],
    send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
    // A PRESENÇA deste campo é o marcador de "corpo escrito pela IA" — é o que
    // separa o texto do modelo de template, resposta aprovada e aviso de código.
    enforceInternalVocabulary: true,
    ...extras,
  };
}

describe("o ajuste de estilo alcança o texto que sai", () => {
  it("o corpo que chega ao canal é o reescrito, não o do modelo", async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos, { ligado: true });
    let enviado = "";

    const r = await runBeforeSend(
      argsDoTurno(pool, {
        send: async (body) => {
          enviado = body;
          return { kind: "sent", idempotencyKey: "k", messageId: "m1" };
        },
      }),
    );

    expect(r.status).toBe("sent");
    expect(enviado).toBe("Olá, segue o orçamento");
  });

  it("com a preferência DESLIGADA o texto do modelo sai intacto", async () => {
    // O controle: sem ele, uma função que reescrevesse sempre passaria no caso
    // acima — e o default do produto (#378) é não mexer no texto de ninguém.
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos, { ligado: false });
    let enviado = "";

    await runBeforeSend(
      argsDoTurno(pool, {
        send: async (body) => {
          enviado = body;
          return { kind: "sent", idempotencyKey: "k", messageId: "m2" };
        },
      }),
    );

    expect(enviado).toBe("Olá — segue o orçamento");
  });

  it("a preferência é lida ANTES do begin — consulta que falha não envenena a transação", async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos, { ligado: true });

    await runBeforeSend(argsDoTurno(pool));

    // A ordem é o contrato: ler depois do `begin` faz uma falha aqui abortar a
    // transação, e a consulta seguinte morre com 25P02 dizendo outra coisa.
    expect(eventos.indexOf("le_estilo")).toBeGreaterThan(eventos.indexOf("connect"));
    expect(eventos.indexOf("le_estilo")).toBeLessThan(eventos.indexOf("begin"));
  });

  it("a reescrita entra no trace, com o ajuste ligado e sem o corpo", async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos, { ligado: true });

    const r = await runBeforeSend(argsDoTurno(pool));

    expect(r.status).toBe("sent");
    const linha = r.trace.find((t) => t.gate === "ajustes_de_estilo");
    expect(linha, "a reescrita não deixou rastro nenhum").toBeDefined();
    expect(linha!.verdict).toBe("pass");
    expect(linha!.code).toBe("aplicado");
    expect(linha!.detail?.ligados).toBe("sem_travessao_longo");
    // Sem PII: o trace leva rótulos e números, nunca o texto.
    expect(JSON.stringify(linha)).not.toContain("orçamento");
  });

  it("texto sem travessão, com a preferência ligada, registra `sem_mudanca`", async () => {
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos, { ligado: true });

    const r = await runBeforeSend(argsDoTurno(pool, { body: "Olá, segue o orçamento" }));

    const linha = r.trace.find((t) => t.gate === "ajustes_de_estilo");
    expect(linha?.verdict).toBe("skipped");
    expect(linha?.code).toBe("sem_mudanca");
  });

  it("falha ao ler a preferência: o envio acontece e o trace diz que NÃO se soube perguntar", async () => {
    // Degradar para desligado é certo — estilo não derruba atendimento. Degradar
    // em SILÊNCIO não: "a organização desligou" e "não consegui perguntar"
    // passariam a ter a mesma cara na auditoria.
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos, { falharNoEstilo: true });
    let enviado = "";

    const r = await runBeforeSend(
      argsDoTurno(pool, {
        send: async (body) => {
          enviado = body;
          return { kind: "sent", idempotencyKey: "k", messageId: "m3" };
        },
      }),
    );

    expect(r.status).toBe("sent");
    expect(enviado).toBe("Olá — segue o orçamento");
    const linha = r.trace.find((t) => t.gate === "ajustes_de_estilo");
    expect(linha?.verdict).toBe("skipped");
    expect(linha?.code).toBe("leitura_falhou");
    // E a transação seguiu normalmente: a leitura falhou ANTES do `begin`.
    expect(eventos).toContain("commit");
    expect(eventos).not.toContain("rollback");
  });

  it("envio que NÃO é do modelo não passa por preferência de estilo nenhuma", async () => {
    // Template, resposta aprovada e aviso de código não têm `enforceInternalVocabulary`.
    // Sem este caso, o ajuste vazaria para texto que a organização escreveu à mão.
    const eventos: Eventos = [];
    const { pool } = poolFalso(eventos, { ligado: true });
    let enviado = "";

    const r = await runBeforeSend({
      ...argsDoTurno(pool, {
        send: async (body) => {
          enviado = body;
          return { kind: "sent", idempotencyKey: "k", messageId: "m4" };
        },
      }),
      enforceInternalVocabulary: undefined,
    });

    expect(enviado).toBe("Olá — segue o orçamento");
    expect(eventos).not.toContain("le_estilo");
    expect(r.status === "sent" && r.trace.some((t) => t.gate === "ajustes_de_estilo")).toBe(false);
  });
});
