import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * CONTRATO DO CRON — o que os dois agendadores da #2235 enxergam.
 *
 * `docker/scheduler/entrypoint.sh:59` e o crontab do kit
 * (`hostgator-setup-kit/_common.sh`, `setup_event_log_drain_cron`) são `curl` de
 * crontab: qualquer resposta não-2xx vira falha no log/relatório a cada minuto.
 * Por isso "outra passada está drenando" precisa continuar 200 — este arquivo
 * existe para que trocar o 200 por 409 (que "parece" mais correto para um
 * conflito) reprove aqui em vez de encher o log de duas instalações.
 *
 * A trava em si é provada contra o Postgres em
 * `tests/invariants/drain-unico-por-vez.test.ts`; aqui só o HTTP.
 */
const { drenar } = vi.hoisted(() => ({ drenar: vi.fn() }));

vi.mock("@/lib/event-log/trava-do-dreno", () => ({
  drenarSozinho: (...args: unknown[]) => drenar(...args),
}));
vi.mock("@/lib/event-log/register-handlers", () => ({ ensureHandlersRegistered: () => {} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ fake: "admin" }) }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));

import { GET } from "./route";

const req = { headers: new Headers() } as unknown as NextRequest;

beforeEach(() => drenar.mockReset());

describe("GET/POST /api/v1/cron/event-log-drain", () => {
  it("outra passada drenando: 200 com o campo de pulo (nunca 409)", async () => {
    drenar.mockResolvedValue({ ok: true, pulado: "outro_dreno" });

    const res = await GET(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { ok: true, pulado: "outro_dreno" } });
  });

  it("passada normal: 200 com o resumo do dreno, sem campo de pulo", async () => {
    drenar.mockResolvedValue({ scanned: 2, done: 2, retried: 0, failed: 0, dead: 0 });

    const res = await GET(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { scanned: 2, done: 2 } });
  });

  it("fila vazia: 200 com contadores zerados", async () => {
    drenar.mockResolvedValue({ scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 });

    const res = await GET(req);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { scanned: 0 } });
  });
});
