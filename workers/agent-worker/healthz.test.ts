/**
 * O `/healthz` DO WORKER ENXERGA O DRAIN DA IA PARADO (#2505).
 *
 * ─── O caso real ────────────────────────────────────────────────────────────
 *
 * O drain do `ai_agent.dispatch_requested` ficou DOIS DIAS esperando uma
 * consulta que nunca voltou (#2501): o `/healthz` dizia `ok`, e os eventos se
 * acumulavam com `attempts=0`. O conserto da causa foi o #2501; o que se mede
 * aqui é a VISIBILIDADE — o carimbo do último tick e o 503 depois do limite.
 *
 * ⚠️ O SERVIDOR É O DE PRODUÇÃO (`./healthz`), numa porta efêmera, e o laço é o
 * de produção (`runDrainLoop`) contra um pool de mentira. O caso ⭐ trava o tick
 * com uma promessa que NUNCA resolve — o formato exato do incidente — e prova,
 * pela porta de verdade, que a resposta vira 503 depois do limite.
 *
 * `metricsSnapshot`/`sessionHealthMetrics` são dublados: o alvo aqui é o laço,
 * e um banco fake para as duas consultas deles só acrescentaria ruído.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type pg from "pg";

vi.mock("@/lib/agent-engine/obs/metrics", () => ({
  profundidadeDaFilaViva: async () => ({ pending: 0, running: 0 }),
  metricsSnapshot: async () => ({}),
}));
vi.mock("@/lib/agent-engine/edge/crm/session-watchdog", () => ({
  sessionHealthMetrics: async () => [],
}));

import type { Logger } from "@/lib/agent-engine/obs/logger";

import { createHealthzServer } from "./healthz";
import {
  _reiniciarVigilanciaDoDrain,
  prontidaoDoDrainDaIa,
  runDrainLoop,
  type DrainKnobs,
} from "@/lib/agent-engine/edge/crm/drain";

/** Limite do teste: 20 × 20ms = 400ms (o default da instalação é 20 × 15s). */
const KNOBS: DrainKnobs = {
  batchSize: 20,
  intervalMs: 5,
  idleIntervalMs: 20,
  debounceMs: 0,
  reapTimeoutMs: 1_000,
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

/** O formato do incidente: a consulta trava e o tick nunca conclui. */
const poolQueNuncaResponde = () =>
  ({ query: () => new Promise(() => {}) }) as unknown as pg.Pool;
/** Um Postgres sem nada a fazer: o tick conclui na hora. */
const poolOcioso = () => ({ query: async () => ({ rows: [] }) }) as unknown as pg.Pool;

interface CorpoDoHealthz {
  status: string;
  db: string;
  ia_drain: { ultimo_tick_ha_ms: number | null; limite_ms: number | null; parado: boolean };
}

describe("laço do drain × /healthz (#2505)", () => {
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    server = createHealthzServer(poolOcioso(), log, 60_000);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endereco = server.address();
    const porta = typeof endereco === "object" && endereco !== null ? endereco.port : 0;
    url = `http://127.0.0.1:${porta}/healthz`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    _reiniciarVigilanciaDoDrain();
  });

  it("controle: laço que dá a volta responde 200 com `ia_drain` saudável", async () => {
    const abort = new AbortController();
    const loop = runDrainLoop(poolOcioso(), KNOBS, log, abort.signal);

    // ESPERA MAIOR QUE O LIMITE (400ms) de propósito: com o laço girando, cada
    // volta RE-CARIMBA; se o carimbo só fosse gravado no começo, esta espera
    // sozinha já teria virado o limite — é o que pega o esquecimento do stamp.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const res = await fetch(url);
    const corpo = (await res.json()) as CorpoDoHealthz;
    expect(res.status).toBe(200);
    expect(corpo.status).toBe("ok");
    expect(corpo.ia_drain.parado).toBe(false);
    expect(corpo.ia_drain.ultimo_tick_ha_ms).toBeGreaterThanOrEqual(0);
    expect(corpo.ia_drain.limite_ms).toBe(KNOBS.idleIntervalMs * 20);

    abort.abort();
    await loop;
  });

  it("⭐ tick travado (promessa que nunca resolve): 503 `degraded` depois do limite", async () => {
    const abort = new AbortController();
    // Fire-and-forget: o laço fica preso DENTRO do tick para sempre — é o caso
    // real. Abortar a signal não o tira de lá, e o teste não o espera.
    void runDrainLoop(poolQueNuncaResponde(), KNOBS, log, abort.signal);

    await new Promise((resolve) => setTimeout(resolve, 450)); // > 400ms de limite

    const res = await fetch(url);
    const corpo = (await res.json()) as CorpoDoHealthz;

    expect(res.status, "healthz verde com o laço travado é o defeito da issue").toBe(503);
    expect(corpo.status).toBe("degraded");
    expect(corpo.db, "o banco está ok — o degradado é o LAÇO").toBe("ok");
    expect(corpo.ia_drain.parado).toBe(true);
    expect(corpo.ia_drain.limite_ms).toBe(KNOBS.idleIntervalMs * 20);

    abort.abort();
  });

  it("laço que ainda não começou não é 'parado' (worker recém-subido)", async () => {
    _reiniciarVigilanciaDoDrain();

    const res = await fetch(url);
    const corpo = (await res.json()) as CorpoDoHealthz;

    expect(res.status).toBe(200);
    expect(corpo.ia_drain).toMatchObject({ ultimo_tick_ha_ms: null, parado: false });
    // E o estado cru concorda com o que a porta publicou.
    expect(prontidaoDoDrainDaIa().parado).toBe(false);
  });
});
