import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/event-log/drain", () => ({
  drainEventLog: vi.fn(async () => ({ drained: 0 })),
}));
vi.mock("@/lib/event-log/register-handlers", () => ({
  ensureHandlersRegistered: vi.fn(),
}));

import { drenarEventosDoInbound, kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";
import { env } from "@/lib/env";
import { drainEventLog } from "@/lib/event-log/drain";

describe("kickLocalPipeline", () => {
  it("não propaga erro do tick do contato (contrato: nunca 5xx no webhook)", async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => {
              throw new Error("boom do mock");
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      kickLocalPipeline(admin, {
        organizationId: "org",
        contactId: "contact",
      }),
    ).resolves.toBeUndefined();
  });

  it("acorda a espera existente antes de aplicar o texto (não o contrário)", () => {
    const src = readFileSync(join(process.cwd(), "lib/dev/kick-local-pipeline.ts"), "utf8");
    const acordar = src.indexOf("await acordarFollowupPorInbound(admin, inbound)");
    const aplicar = src.indexOf("await aplicarTextoNosFollowups(admin, inbound)");
    expect(acordar).toBeGreaterThan(0);
    expect(aplicar).toBeGreaterThan(acordar);
  });
});

describe("drenarEventosDoInbound — o webhook não drena a fila de todo mundo quando há worker", () => {
  const ENV_ORIGINAL = env.EVENT_LOG_WORKER_DRAINS;
  // O 2º tick do contato depois do dreno não é o que se mede aqui: o admin
  // falha na primeira consulta, e o contrato fail-soft engole.
  const adminQueFalha = {
    from: () => {
      throw new Error("sem banco neste teste");
    },
  } as unknown as SupabaseClient;
  const INBOUND = { organizationId: "org-1", contactId: "contato-1", messageId: "msg-1", texto: "oi" };

  beforeEach(() => {
    vi.mocked(drainEventLog).mockClear();
  });
  afterEach(() => {
    env.EVENT_LOG_WORKER_DRAINS = ENV_ORIGINAL;
  });

  it("com worker drenando, o dreno é só da organização e dos gatilhos que inscrevem o contato", async () => {
    env.EVENT_LOG_WORKER_DRAINS = "true";
    await drenarEventosDoInbound(adminQueFalha, INBOUND);

    expect(drainEventLog).toHaveBeenCalledTimes(1);
    const [, opts] = vi.mocked(drainEventLog).mock.calls[0]!;
    expect(opts?.escopo?.organizationId).toBe("org-1");
    expect([...(opts?.escopo?.handlers ?? [])].sort()).toEqual([
      "followup-gatilho-lead.v1",
      "followup-gatilho-retorno.v1",
    ]);
  });

  it("sem worker (variável vazia), o dreno continua global — o comportamento de antes", async () => {
    env.EVENT_LOG_WORKER_DRAINS = "";
    await drenarEventosDoInbound(adminQueFalha, INBOUND);

    expect(drainEventLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(drainEventLog).mock.calls[0]).toEqual([adminQueFalha]);
  });

  it("`false` explícito no .env também volta ao dreno global", async () => {
    env.EVENT_LOG_WORKER_DRAINS = "false";
    await drenarEventosDoInbound(adminQueFalha, INBOUND);

    expect(vi.mocked(drainEventLog).mock.calls[0]).toEqual([adminQueFalha]);
  });

  it("sem mensagem (captação) não há organização para escopar: segue global", async () => {
    env.EVENT_LOG_WORKER_DRAINS = "true";
    await drenarEventosDoInbound(adminQueFalha);

    expect(vi.mocked(drainEventLog).mock.calls[0]).toEqual([adminQueFalha]);
  });
});
