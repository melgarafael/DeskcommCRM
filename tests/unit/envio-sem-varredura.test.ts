/**
 * Leituras do caminho de envio que cresciam com o histórico, sem mudar o que
 * respondem. Quatro lugares, quatro blocos:
 *
 * 1. `sendWithLedger` procurava `messages` por `metadata->>'idempotency_key'`
 *    (sem índice) em TODO envio, sob o lock do número — inclusive com a chave
 *    recém-criada, que nenhuma mensagem pode ter. Agora só procura no replay, e
 *    pela PK primeiro.
 * 2. `loadPacingState` contava o histórico inteiro do número (o filtro de data
 *    estava no FILTER, não no WHERE).
 * 3. `countPriorAcceptedSends` contava tudo para responder "existe?".
 * 4. O `/healthz` agrupava a fila inteira por status a cada 30s.
 *
 * O que este arquivo NÃO mede: o plano do Postgres. A forma da query é afirmada
 * aqui; que ela desce pelo índice depende dos índices que o bloco final confere
 * no baseline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  pgSendLedger,
  sendWithLedger,
  supabaseSendLedger,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import { countPriorAcceptedSends } from "@/lib/agent-engine/guardrails/disclosure/template";
import { profundidadeDaFilaViva } from "@/lib/agent-engine/obs/metrics";
import { loadPacingState } from "@/lib/agent-engine/pacing/store";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

type Store = Parameters<typeof sendWithLedger>[0];
const intent = { tenantId: "org", leadId: "contact", jobId: "job", seq: 1, body: "Oi" };

function store(prior: "nenhum" | "requested" | "accepted" | "vetoed" | "failed"): Store {
  return {
    create: vi.fn(async () => {
      if (prior === "nenhum") return "ledger-novo";
      throw { code: "23505" };
    }),
    find: vi.fn(async () =>
      prior === "nenhum"
        ? null
        : { id: "ledger-original", status: prior, crm_message_id: prior === "accepted" ? "m" : null },
    ),
    rotate: vi.fn(async () => "ledger-rodado"),
    message: vi.fn(async () => null),
    update: vi.fn(async () => {}),
  };
}

function fakeDb(respostas: Array<Record<string, unknown>[]>): Queryable & { sqls: string[]; params: unknown[][] } {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  return {
    sqls,
    params,
    query: vi.fn(async (sql: string, p?: unknown[]) => {
      sqls.push(sql);
      params.push(p ?? []);
      return { rows: respostas.shift() ?? [], rowCount: 0 };
    }) as unknown as Queryable["query"],
  };
}

describe("sendWithLedger só procura a mensagem no replay", () => {
  it("chave nova (create ok) não consulta messages e envia com id = chave", async () => {
    const db = store("nenhum");
    const send = vi.fn(async (_k: string, id: string) => ({ id, status: "sent" }));
    expect((await sendWithLedger(db, intent, send)).kind).toBe("sent");
    expect(db.message).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("ledger-novo", "ledger-novo");
  });

  it("rotate (falha anterior) gera chave nova e também não consulta messages", async () => {
    const db = store("failed");
    const send = vi.fn(async (_k: string, id: string) => ({ id, status: "sent" }));
    expect((await sendWithLedger(db, intent, send)).kind).toBe("sent");
    expect(db.message).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("ledger-rodado", "ledger-rodado");
  });

  it("23505 em requested consulta messages pela chave antiga (o replay que reconcilia)", async () => {
    const db = store("requested");
    const send = vi.fn(async (_k: string, id: string) => ({ id, status: "sent" }));
    await sendWithLedger(db, intent, send);
    expect(db.message).toHaveBeenCalledWith("org", "ledger-original");
  });

  it("already_sent e vetoed seguem sem transporte e sem consulta", async () => {
    for (const [prior, kind] of [["accepted", "already_sent"], ["vetoed", "blocked"]] as const) {
      const db = store(prior);
      const send = vi.fn();
      expect((await sendWithLedger(db, intent, send)).kind).toBe(kind);
      expect(send).not.toHaveBeenCalled();
      expect(db.message).not.toHaveBeenCalled();
    }
  });
});

describe("store.message busca pela PK e só cai no metadata se a PK não achar", () => {
  it("pg: achou pela PK → uma query só, sem metadata", async () => {
    const db = fakeDb([[{ id: "k", status: "sent" }]]);
    expect(await pgSendLedger(db).message("org", "k")).toEqual({ id: "k", status: "sent" });
    expect(db.sqls).toHaveLength(1);
    expect(db.sqls[0]).toMatch(/\bid=\$2/);
    expect(db.sqls[0]).not.toContain("metadata");
    expect(db.params[0]).toEqual(["org", "k"]);
  });

  it("pg: PK vazia → reserva pelo metadata (linha anterior à convenção)", async () => {
    const db = fakeDb([[], [{ id: "antiga", status: "queued" }]]);
    expect(await pgSendLedger(db).message("org", "k")).toEqual({ id: "antiga", status: "queued" });
    expect(db.sqls[1]).toContain("metadata->>'idempotency_key'");
  });

  it("supabase: achou pela PK → não consulta metadata", async () => {
    const filtros: Array<Array<[string, unknown]>> = [];
    const respostas = [{ data: { id: "k", status: "sent" }, error: null }];
    const from = vi.fn(() => {
      const eqs: Array<[string, unknown]> = [];
      filtros.push(eqs);
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (eqs.push([c, v]), q),
        limit: () => q,
        maybeSingle: async () => respostas.shift() ?? { data: null, error: null },
      };
      return q;
    });
    const sb = { from } as unknown as SupabaseClient;
    expect(await supabaseSendLedger(sb).message("org", "k")).toEqual({ id: "k", status: "sent" });
    expect(filtros).toEqual([[["organization_id", "org"], ["id", "k"]]]);
  });
});

describe("pacing: sem varrer o histórico do número", () => {
  it("dois subselects pelo índice, mesmo lastSentAt/sentToday", async () => {
    const ultimo = new Date("2026-10-02T13:00:00Z");
    const db = fakeDb([[{ last_sent_at: ultimo, sent_today: "3" }]]);
    const estado = await loadPacingState(db, "org", "sess", {
      now: new Date("2026-10-02T15:00:00Z"),
      timezone: "America/Sao_Paulo",
      numberActivatedAt: null,
    });
    expect(estado).toEqual({ lastSentAt: ultimo, sentToday: 3, numberActivatedAt: null });
    const sql = (db.sqls[0] ?? "").replace(/\s+/g, " ");
    expect(sql).not.toMatch(/filter|max\(/i);
    expect(sql).toContain("order by sent_at desc limit 1");
    expect(sql).toMatch(/and sent_at >= \$3\) as sent_today/);
    // Meia-noite de São Paulo = 03:00Z: o início do dia vem do `now` injetado.
    expect(db.params[0]).toEqual(["org", "sess", new Date("2026-10-02T03:00:00Z")]);
  });

  it("número sem envio nenhum continua lastSentAt null e sentToday 0", async () => {
    const db = fakeDb([[{ last_sent_at: null, sent_today: "0" }]]);
    const estado = await loadPacingState(db, "org", "sess", {
      now: new Date(),
      timezone: "America/Sao_Paulo",
      numberActivatedAt: null,
    });
    expect(estado).toMatchObject({ lastSentAt: null, sentToday: 0 });
  });
});

describe("disclosure: primeiro outbound pergunta se existe, não conta", () => {
  it("exists no lugar de count; 0 só quando não há aceito", async () => {
    const com = fakeDb([[{ existe: true }]]);
    expect(await countPriorAcceptedSends(com, "org", "contact")).toBe(1);
    expect(com.sqls[0]).toMatch(/select exists\(/);
    expect(com.sqls[0]).not.toMatch(/count\(/);
    expect(com.params[0]).toEqual(["org", "contact"]);
    const sem = fakeDb([[{ existe: false }]]);
    expect(await countPriorAcceptedSends(sem, "org", "contact")).toBe(0);
  });
});

describe("/healthz: só a fila viva, pelos índices parciais", () => {
  it("duas contagens por status, sem group by", async () => {
    const db = fakeDb([[{ pending: 4, running: 1 }]]);
    expect(await profundidadeDaFilaViva(db)).toEqual({ pending: 4, running: 1 });
    expect(db.sqls[0]).not.toMatch(/group by/i);
    expect(db.sqls[0]).toContain("where status = 'pending'");
    expect(db.sqls[0]).toContain("where status = 'running'");
  });

  it("o handler do worker usa a função, não o group by antigo", () => {
    const main = readFileSync(join(process.cwd(), "workers", "agent-worker", "main.ts"), "utf8");
    expect(main).toContain("await profundidadeDaFilaViva(pool)");
    const inicio = main.indexOf("const uptime_s");
    // O fim procurado DEPOIS do início: há um `respond(res, 503` antes dele (a
    // checagem do banco), e com ele o recorte saía vazio e a asserção passava sem ler nada.
    const healthz = main.slice(inicio, main.indexOf("respond(res, 503", inicio));
    expect(healthz).toContain("profundidadeDaFilaViva(pool)");
    expect(healthz).not.toMatch(/group by/i);
  });

  it("os índices de que as queries dependem existem no baseline", () => {
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    expect(baseline).toMatch(/idx_job_queue_claim on job_queue \(status, run_after\) where status = 'pending'/);
    expect(baseline).toMatch(/idx_job_queue_running\s+on job_queue \(status\) where status = 'running'/);
    expect(baseline).toMatch(
      /idx_pacing_ledger_session\s+on pacing_ledger \(organization_id, channel_session_id, sent_at desc\)/,
    );
  });
});
