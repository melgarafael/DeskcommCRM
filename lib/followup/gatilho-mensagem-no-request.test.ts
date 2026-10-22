import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ drain: vi.fn(async () => ({})) }));

vi.mock("@/lib/event-log/drain", () => ({ drainEventLog: h.drain }));
vi.mock("@/lib/event-log/register-handlers", () => ({ ensureHandlersRegistered: () => undefined }));
vi.mock("@/lib/event-log/origem-do-dreno", () => ({ comOrigemDeRequest: (fn: () => unknown) => fn() }));

import { FOLLOWUP_GATILHO_MENSAGEM_HANDLER_KEY } from "./gatilho-mensagem.handler";
import { dispararGatilhosDeMensagem } from "./gatilho-mensagem-no-request";

const INBOUND = { organizationId: "org-1", contactId: "ct-1", messageId: "msg-1" };

/** Supabase falso: devolve, por tabela, o resultado da consulta encadeada. */
function admin(por: { pointers?: number; eventos?: unknown[]; erro?: boolean }): SupabaseClient {
  return {
    from(tabela: string) {
      if (por.erro) throw new Error("banco fora");
      const resultado =
        tabela === "followup_flow_pointers"
          ? { count: por.pointers ?? 0, error: null }
          : { data: por.eventos ?? [], error: null };
      const cadeia: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) cadeia[m] = () => cadeia;
      cadeia.then = (ok: (v: unknown) => unknown) => Promise.resolve(resultado).then(ok);
      return cadeia;
    },
  } as unknown as SupabaseClient;
}

describe("dispararGatilhosDeMensagem — o webhook decide antes de chamar o agente", () => {
  beforeEach(() => h.drain.mockClear());

  it("sem fluxo de mensagem na organização: uma contagem e nada mais", async () => {
    expect(await dispararGatilhosDeMensagem(admin({ pointers: 0 }), INBOUND)).toBe(false);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it("drena SÓ o gatilho de mensagem, desta organização, e diz que o fluxo falou", async () => {
    expect(await dispararGatilhosDeMensagem(admin({ pointers: 1, eventos: [{ id: "ev" }] }), INBOUND)).toBe(true);
    expect(h.drain).toHaveBeenCalledTimes(1);
    const [, opts] = h.drain.mock.calls[0] as unknown as [unknown, { escopo: { organizationId: string; handlers: string[] } }];
    expect(opts.escopo).toEqual({ organizationId: "org-1", handlers: [FOLLOWUP_GATILHO_MENSAGEM_HANDLER_KEY] });
  });

  it("fluxo armado que não casou esta mensagem: o agente é chamado", async () => {
    expect(await dispararGatilhosDeMensagem(admin({ pointers: 1, eventos: [] }), INBOUND)).toBe(false);
  });

  it("sem id da mensagem (reentrega) não faz nada", async () => {
    expect(await dispararGatilhosDeMensagem(admin({ pointers: 1 }), { ...INBOUND, messageId: null })).toBe(false);
    expect(h.drain).not.toHaveBeenCalled();
  });

  it("falha para dentro: banco fora = o agente decide", async () => {
    expect(await dispararGatilhosDeMensagem(admin({ erro: true }), INBOUND)).toBe(false);
  });
});
