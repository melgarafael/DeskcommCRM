/**
 * A REGRA do cron `event-log-purge`.
 *
 * `event_log` nunca tinha limpeza — `lib/event-log/drain.ts` só faz `UPDATE
 * status='done'|'dead'`, a linha nunca sai da tabela. Achado ao comparar com o
 * changelog do upstream (DeskcommCRM 1.4.0: "limpeza automática do banco").
 *
 * O que se guarda aqui, com um dublê do client:
 *   1. `pending`/`processing` NUNCA são tocados — só `done`/`dead` entram na
 *      query, porque esses dois estados têm dono (o drain reagenda) e apagá-
 *      los perderia evento que ainda vai acontecer;
 *   2. o corte é por `updated_at` (quando ENTROU no estado terminal), não
 *      `created_at` — medir pela criação apagaria um evento `dead` recente
 *      cujo primeiro attempt foi há muito tempo (created_at velho, updated_at
 *      novo) antes de alguém ter chance de ler `last_error`;
 *   3. `done` tem corte mais curto que `dead` — sucesso não precisa de
 *      investigação, falha esgotada merece mais tempo na tela;
 *   4. o delete usa SELECT-então-DELETE-por-id, nunca `DELETE ... LIMIT`
 *      direto — PostgREST não aceita `limit`/`order` em mutação.
 */
import { describe, expect, it } from "vitest";

import { DEAD_RETENTION_MS, DONE_RETENTION_MS, purgeEventLog } from "@/app/api/v1/cron/event-log-purge/route";

interface Chamada {
  tabela: string;
  op: string;
  filtros: Record<string, unknown>;
}

/** Dublê mínimo: cada `status` pedido devolve as linhas presas daquele status. */
function clientDuble(presasPorStatus: Record<string, { id: string }[]>) {
  const chamadas: Chamada[] = [];
  const client = {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let op = "select";
      let statusPedido: string | undefined;
      const cadeia: Record<string, unknown> = {
        select() {
          return cadeia;
        },
        delete() {
          op = "delete";
          return cadeia;
        },
        eq(col: string, val: unknown) {
          filtros[`eq:${col}`] = val;
          if (col === "status") statusPedido = val as string;
          return cadeia;
        },
        lt(col: string, val: unknown) {
          filtros[`lt:${col}`] = val;
          return cadeia;
        },
        in(col: string, val: unknown) {
          filtros[`in:${col}`] = val;
          return {
            then(resolve: (r: unknown) => unknown) {
              chamadas.push({ tabela, op, filtros });
              return Promise.resolve(resolve({ data: null, error: null }));
            },
          };
        },
        limit() {
          chamadas.push({ tabela, op, filtros });
          return Promise.resolve({ data: presasPorStatus[statusPedido ?? ""] ?? [], error: null });
        },
      };
      return cadeia;
    },
  };
  return { client, chamadas };
}

describe("event-log-purge — a regra", () => {
  it("apaga só done/dead, nunca pending/processing", async () => {
    const { client, chamadas } = clientDuble({
      done: [{ id: "d1" }],
      dead: [{ id: "x1" }],
    });

    await purgeEventLog(client as never, new Date("2026-08-30T12:00:00Z"));

    const statusPedidos = chamadas
      .filter((c) => c.op === "select")
      .map((c) => c.filtros["eq:status"]);
    expect(statusPedidos.sort()).toEqual(["dead", "done"]);
    expect(statusPedidos).not.toContain("pending");
    expect(statusPedidos).not.toContain("processing");
  });

  it("filtra por updated_at, não created_at", async () => {
    const { client, chamadas } = clientDuble({ done: [], dead: [] });

    await purgeEventLog(client as never, new Date("2026-08-30T12:00:00Z"));

    for (const c of chamadas.filter((x) => x.op === "select")) {
      expect(Object.keys(c.filtros).some((k) => k.startsWith("lt:updated_at"))).toBe(true);
      expect(Object.keys(c.filtros).some((k) => k.startsWith("lt:created_at"))).toBe(false);
    }
  });

  it("done usa corte mais curto que dead", () => {
    expect(DONE_RETENTION_MS).toBeLessThan(DEAD_RETENTION_MS);
  });

  it("o corte de cada status é aplicado corretamente (done 14d, dead 30d)", async () => {
    const now = new Date("2026-08-30T12:00:00Z");
    const { client, chamadas } = clientDuble({ done: [], dead: [] });

    await purgeEventLog(client as never, now);

    const doneCall = chamadas.find((c) => c.op === "select" && c.filtros["eq:status"] === "done")!;
    const deadCall = chamadas.find((c) => c.op === "select" && c.filtros["eq:status"] === "dead")!;

    expect(doneCall.filtros["lt:updated_at"]).toBe(new Date(now.getTime() - DONE_RETENTION_MS).toISOString());
    expect(deadCall.filtros["lt:updated_at"]).toBe(new Date(now.getTime() - DEAD_RETENTION_MS).toISOString());
  });

  it("sem linhas presas: nenhum DELETE é chamado, e o resultado é zero", async () => {
    const { client, chamadas } = clientDuble({ done: [], dead: [] });

    const result = await purgeEventLog(client as never, new Date("2026-08-30T12:00:00Z"));

    expect(result).toEqual({ deleted_done: 0, deleted_dead: 0 });
    expect(chamadas.some((c) => c.op === "delete")).toBe(false);
  });

  it("com linhas presas: DELETE roda por id, e o resultado conta as linhas", async () => {
    const { client, chamadas } = clientDuble({
      done: [{ id: "d1" }, { id: "d2" }],
      dead: [{ id: "x1" }],
    });

    const result = await purgeEventLog(client as never, new Date("2026-08-30T12:00:00Z"));

    expect(result).toEqual({ deleted_done: 2, deleted_dead: 1 });
    expect(chamadas.filter((c) => c.op === "delete")).toHaveLength(2);
  });
});
