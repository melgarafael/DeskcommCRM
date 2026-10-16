// @vitest-environment node
/**
 * O watchdog de sessão e o redrive no DESLIGAMENTO (#2823).
 *
 * O `shutdown` do worker faz `await` em todos os laços ANTES de começar o
 * próprio prazo (SHUTDOWN_GRACE_MS), então o que o watchdog faz com o abort é o
 * que decide quanto tempo o `docker stop` herda:
 *
 *   (a) o abort pode chegar DURANTE o tick — sem a checagem depois do await, o
 *       laço entra na espera com o signal JÁ abortado. `addEventListener` de um
 *       signal abortado nunca dispara (o evento passou), então ele dorme os
 *       60 s do intervalo inteiro, com o shutdown pendurado atrás dele;
 *   (b) entre itens do lote o redrive PARA, mas não cancela o envio em voo — o
 *       POST que já começou termina e grava o recibo; o que não pode nascer é o
 *       SEGUNDO item com o processo já de saída.
 *
 * Sem Postgres e sem WAHA: banco falso que aplica o vocabulário das consultas e
 * `fetch` falso que é o WAHA — mesmo desenho de
 * `lib/agent-engine/edge/crm/session-reconciler.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

import type { Logger } from "@/lib/agent-engine/obs/logger";
import { redriveQueued, runSessionWatchdogLoop } from "@/lib/agent-engine/edge/crm/session-reconciler";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const CFG = {
  wahaBaseUrl: "http://127.0.0.1:9",
  wahaApiKey: "***",
  intervalMs: 60_000,
  redriveMinAgeMs: 0,
  redriveBatchSize: 10,
  redriveSpacingMs: 0,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function poolVazio(): pg.Pool {
  return { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool;
}

interface Msg {
  id: string;
  organization_id: string;
  conversation_id: string;
  body: string;
  sent_via: string;
  waha_session_name: string;
  wa_identity: string | null;
  wa_lid: string | null;
  phone_number: string | null;
  is_group: boolean;
  group_chat_id: string | null;
}

function msg(id: string): Msg {
  return {
    id,
    organization_id: "org-1",
    conversation_id: "conversa-1",
    body: "Resposta em voo",
    sent_via: "ai",
    waha_session_name: "default",
    wa_identity: "phone:+5531999990000",
    wa_lid: null,
    phone_number: "+5531999990000",
    is_group: false,
    group_chat_id: null,
  };
}

/** Banco falso que DESCOBRE cada consulta pelo vocabulário, como o teste #652. */
function bancoComFila(fila: Msg[], aoLerElegibilidade: () => void = () => undefined) {
  const consultas: string[] = [];
  const query = vi.fn(async (sql: string) => {
    consultas.push(sql);
    if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "0" }] };
    if (/select\s+m\.id/i.test(sql)) return { rows: fila.map((l) => ({ ...l })) };
    if (/select\s+s\.metadata/i.test(sql)) {
      aoLerElegibilidade();
      return { rows: [{ metadata: {}, phone_number: "+5531999990000", operante: true }] };
    }
    return { rows: [] };
  });
  return { query, consultas };
}

describe("watchdog: abort DURANTE o tick (#2823)", () => {
  it("encerra o laço na hora — sem herdar os 60 s do intervalo nem deixar timer pendurado", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort(); // o SIGTERM chega enquanto o tick ainda roda
      return new Response("[]", { status: 200 });
    });

    let saiu = false;
    const laco = runSessionWatchdogLoop(poolVazio(), CFG, log, controller.signal).then(() => {
      saiu = true;
    });
    await vi.advanceTimersByTimeAsync(0); // o tick inteiro (promessas resolvem nos microtasks)
    await Promise.resolve();

    expect(saiu, "o laço entrou na espera com o signal já abortado — o shutdown herda o intervalo").toBe(true);
    expect(vi.getTimerCount(), "timer da espera que o abort não cancelou").toBe(0);

    controller.abort();
    await laco;
  });
});

describe("watchdog: a espera não deixa ouvinte morto (#2823)", () => {
  it("remove o listener de abort a cada volta — sem acumular um por tick no mesmo signal", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));

    const laco = runSessionWatchdogLoop(poolVazio(), CFG, log, controller.signal);
    // Duas voltas completas + entrada na terceira espera.
    await vi.advanceTimersByTimeAsync(CFG.intervalMs * 2 + 1);
    expect(add.mock.calls.length).toBeGreaterThanOrEqual(3);

    controller.abort(); // termina a espera em curso e o laço
    await laco;

    expect(
      remove.mock.calls.length,
      "ouvinte de abort abandonado no signal a cada tick — vazamento que só aparece como memória",
    ).toBe(add.mock.calls.length);
  });
});

describe("redrive: para entre itens, não cancela o envio em voo (#2823)", () => {
  it("abort DURANTE a espera de elegibilidade: nenhum envio nasce depois do sinal", async () => {
    const controller = new AbortController();
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: { id: "3EB0ABCDEF" } }), { status: 200 }),
    );
    const { query } = bancoComFila([msg("m-1"), msg("m-2")], () => controller.abort());

    const reenviadas = await redriveQueued(
      { query } as unknown as pg.Pool,
      CFG,
      log,
      controller.signal,
    );

    expect(send, "o sinal chegou antes de qualquer POST — o lote não podia continuar").not.toHaveBeenCalled();
    expect(reenviadas).toBe(0);
  });

  it("abort com o envio em voo: POST e recibo são únicos e nenhum segundo item sai", async () => {
    const controller = new AbortController();
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort(); // o SIGTERM chega enquanto o POST está no ar
      return new Response(JSON.stringify({ id: { id: "3EB0ABCDEF" } }), { status: 200 });
    });
    const { query, consultas } = bancoComFila([msg("m-1"), msg("m-2")]);

    const reenviadas = await redriveQueued(
      { query } as unknown as pg.Pool,
      CFG,
      log,
      controller.signal,
    );

    expect(reenviadas, "o lote continuou depois do abort e mandou o item seguinte").toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      consultas.filter((sql) => sql.includes("set status = 'sent'")),
      "o recibo do envio que já saiu tem de ser gravado — uma vez só",
    ).toHaveLength(1);
  });
});
