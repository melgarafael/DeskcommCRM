import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/event-log/drain", () => ({
  drainEventLog: vi.fn(async () => ({ drained: 0 })),
}));
// REGISTER-HANDLERS PREGUIÇOSO: o factory marca QUANDO o módulo foi carregado. O pipeline o
// importa só dentro do dreno; importar o pipeline (o que toda ingestão do canal faz) não pode carregá-lo.
const registro = vi.hoisted(() => ({ carregado: false, ensure: vi.fn() }));
vi.mock("@/lib/event-log/register-handlers", () => {
  registro.carregado = true;
  return { ensureHandlersRegistered: registro.ensure };
});

import { drenarEventosDoInbound, kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";
import { env } from "@/lib/env";
import { drainEventLog } from "@/lib/event-log/drain";

// Lido logo depois dos imports: o que o import do pipeline carregou, antes de qualquer caso chamar o dreno.
const carregadoAoImportar = registro.carregado;

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

describe("REGISTER-HANDLERS PREGUIÇOSO", () => {
  // No topo do arquivo, o import do register-handlers levava os workers de IA, LGPD, RAG… a todo mundo que importa
  // a ingestão do canal. O caso « o webhook de status AVISA » do channel-health-aviso pagava esse custo dentro dos
  // 15 s dele, e estourava sob carga.
  const adminQueFalha = {
    from: () => {
      throw new Error("sem banco neste teste");
    },
  } as unknown as SupabaseClient;

  it("importar o pipeline não carrega o register-handlers", () => {
    expect(carregadoAoImportar).toBe(false);
  });

  it("o dreno registra os handlers antes de drenar", async () => {
    vi.mocked(drainEventLog).mockClear();
    registro.ensure.mockClear();
    await drenarEventosDoInbound(adminQueFalha);

    expect(registro.carregado).toBe(true);
    expect(registro.ensure).toHaveBeenCalledTimes(1);
    expect(drainEventLog).toHaveBeenCalledTimes(1);
    expect(registro.ensure.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(drainEventLog).mock.invocationCallOrder[0]!,
    );
  });
});
