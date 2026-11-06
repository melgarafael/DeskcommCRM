/**
 * #3529: a fiação passa pelo runBeforeSend REAL, sem chamar o gate por fora.
 * Pool e transporte são controlados; não há PostgreSQL, HTTP ou modelo nesta prova.
 * Remover o repasse args.registro -> ctx.registro deixa os negativos vermelhos.
 */
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import {
  criarEfeitoDasEscrituras,
  type DesfechoDaEscrita,
} from "@/lib/ai/runtime/efeito-das-escritas";

const AFIRMACAO = "Já registrei seu interesse.";

function tentarEnvio(body: string, desfecho?: DesfechoDaEscrita) {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rows: [{ id: "trace-registro" }] }),
  } as unknown as pg.Pool;
  const efeitos = criarEfeitoDasEscrituras();
  if (desfecho !== undefined) efeitos.registrar("crm_create_lead", desfecho);
  const send = vi.fn(async (_body: string) => ({
    kind: "sent" as const,
    idempotencyKey: "registro-real-k",
    messageId: "registro-real-m",
  }));
  // A variável reproduz a fronteira real do inbound-turn: campo adicional no
  // objeto não garante que o runner o carregue para seu GateContext.
  const args = {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: "00000000-0000-4000-8000-000000000001",
    leadId: "00000000-0000-4000-8000-000000000002",
    jobId: "00000000-0000-4000-8000-000000000003",
    channelSessionId: "00000000-0000-4000-8000-000000000004",
    body,
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date("2026-10-26T13:00:00.000Z"),
    rng: () => 0,
    sleep: async () => {},
    registro: { active: true, ferramentas: ["crm_create_lead"], efeitos },
    send,
  };
  return { result: runBeforeSend(args), send };
}

describe("registro chega ao contexto da cadeia real de envio", () => {
  it.each([undefined, "falhou", "incerto"] as const)(
    "sem efeito confirmado (%s), a afirmação não chama o transporte",
    async (desfecho) => {
      const { result, send } = tentarEnvio(AFIRMACAO, desfecho);
      const r = await result;
      expect(r.status).toBe("vetoed");
      expect(send).not.toHaveBeenCalled();
      if (r.status !== "vetoed") throw new Error("esperava veto da cadeia real");
      expect(r.gate).toBe("registro_sem_efeito");
      expect(r.code).toBe("registro_afirmado_sem_efeito");
    },
  );

  it("controle positivo: efeito confirmado permite a mesma afirmação uma vez", async () => {
    const { result, send } = tentarEnvio(AFIRMACAO, "produziu_efeito");
    const r = await result;
    expect(r.status).toBe("sent");
    expect(send).toHaveBeenCalledExactlyOnceWith(AFIRMACAO);
    expect(r.trace).toContainEqual({ gate: "registro_sem_efeito", verdict: "pass" });
  });

  it.each(["Seu interesse será registrado.", "Seu interesse pode ser registrado."])(
    "futuro/possibilidade sem efeito não afirma registro consumado: %s",
    async (body) => {
      const { result, send } = tentarEnvio(body);
      expect((await result).status).toBe("sent");
      expect(send).toHaveBeenCalledExactlyOnceWith(body);
    },
  );
});
