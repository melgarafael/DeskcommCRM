/**
 * O AVISO DA CENTRAL QUANDO O DRAIN DA IA TRAVA (#2505).
 *
 * O molde é o do aviso do laço do event_log (`event-log-loop-avisa-central`):
 * pane global vira uma linha por organização, dedupe por título estável,
 * resolução sozinha, e falha da Central NUNCA é `error` — o aviso é acessório,
 * o incidente já tem o 503 do `/healthz` e o log do reaper.
 *
 * Aqui se mede o EMISSOR DE PRODUÇÃO (`sincronizarAvisoDoDrain`) contra um pool
 * de mentira; o que ele escreve no banco de verdade é SQL direto e coberto
 * pelos invariantes de `agent_inbox_items`.
 */
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import type { Logger } from "@/lib/agent-engine/obs/logger";

import { sincronizarAvisoDoDrain, TITULO_DRAIN_PARADO } from "./vigilancia-do-drain";

function fakePool(erro?: Error) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (erro) throw erro;
      consultas.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
  } as unknown as pg.Pool;
  return { pool, consultas };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

describe("aviso do laço do drain — feedback visível (#2505)", () => {
  it("parado: abre por organização faltante numa instrução só, com dedupe por título", async () => {
    const { pool, consultas } = fakePool();

    await sincronizarAvisoDoDrain(pool, "parado", log);

    expect(consultas).toHaveLength(1);
    const { sql, params } = consultas[0]!;
    expect(sql).toContain("insert into agent_inbox_items");
    expect(sql, "sem o `not exists` o reaper abriria um aviso por tique").toContain("not exists");
    expect(sql).toContain("'other'");
    expect(sql).toContain("'warn'");
    expect(sql, "o título tem de ser parâmetro, não literal colado").toContain("$1");
    expect(params).toEqual([
      TITULO_DRAIN_PARADO,
      expect.stringContaining("parou de avançar"),
    ]);
  });

  it("saudável: resolve o episódio (status resolved + resolved_at)", async () => {
    const { pool, consultas } = fakePool();

    await sincronizarAvisoDoDrain(pool, "saudavel", log);

    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toContain("set status = 'resolved', resolved_at = now()");
    expect(consultas[0]!.sql).toContain("kind = 'other' and title = $1 and status = 'open'");
    expect(consultas[0]!.params).toEqual([TITULO_DRAIN_PARADO]);
  });

  it("Central fora do ar vira `warn`, nunca `error`, e nunca lança", async () => {
    const { pool } = fakePool(new Error("fetch failed"));
    const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      sincronizarAvisoDoDrain(pool, "parado", l as unknown as Logger),
    ).resolves.toBeUndefined();

    expect(l.error).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledWith(
      expect.stringContaining("falhei ao sincronizar o aviso"),
      expect.objectContaining({ error: "fetch failed" }),
    );
  });

  it("a resolução falha como `warn` — o worker não cai por causa do aviso", async () => {
    const { pool } = fakePool(new Error("fetch failed"));
    const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      sincronizarAvisoDoDrain(pool, "saudavel", l as unknown as Logger),
    ).resolves.toBeUndefined();

    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.error).not.toHaveBeenCalled();
  });
});
