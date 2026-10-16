/**
 * A marca "sempre atendimento humano" (`contacts.ai_opt_out`) vale também no
 * envio do link de reunião pela IA — lida da política, não deduzida de
 * `force_human`. O caso que importa é a deriva: marca ligada com `force_human`
 * desligado por qualquer outro escritor.
 */
import { describe, expect, it } from "vitest";

import {
  assertMeetingDeliveryPg,
  assertMeetingDeliverySupabase,
  MeetingDeliveryBlockedError,
} from "@/lib/agenda/meet-delivery";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";

const CONTEXTO = {
  organizationId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
  jobClaim: { worker_id: "w", acquired_at: "2026-10-15T00:00:00Z" },
} as Parameters<typeof assertMeetingDeliveryPg>[1];

/** Política de um contato liberado para a IA em tudo, menos no que o caso muda. */
function politica(over: Record<string, unknown> = {}) {
  return {
    current: true,
    human_command: false,
    contact_id: "55555555-5555-4555-8555-555555555555",
    channel_session_id: "66666666-6666-4666-8666-666666666666",
    force_human: false,
    ai_opt_out: false,
    ai_gate: null,
    ai_authorized_at: null,
    assignee_kind: "ai",
    bot_silenced_until: null,
    ...over,
  };
}

const pg = (policy: unknown) =>
  ({ query: async () => ({ rows: [{ policy }] }) }) as unknown as Queryable;
const supa = (data: unknown, error: unknown = null) =>
  ({ rpc: async () => ({ data, error }) }) as unknown as SupabaseClient;

describe("envio do link da agenda e a marca sempre atendimento humano", () => {
  it("controle: contato sem a marca é liberado", async () => {
    await expect(assertMeetingDeliveryPg(pg(politica()), CONTEXTO)).resolves.toMatchObject({
      humanCommand: false,
    });
  });

  it("marca ligada com force_human desligado: recusa pelo motivo da marca", async () => {
    const p = politica({ ai_opt_out: true, force_human: false });
    await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).rejects.toMatchObject({
      reason: "ai_opt_out",
    });
    await expect(assertMeetingDeliverySupabase(supa(p), CONTEXTO)).rejects.toBeInstanceOf(
      MeetingDeliveryBlockedError,
    );
  });

  it("política sem a marca (banco desatualizado) é recusada, nunca lida como desligada", async () => {
    const { ai_opt_out: _ausente, ...semMarca } = politica();
    await expect(assertMeetingDeliveryPg(pg(semMarca), CONTEXTO)).rejects.toThrow();
  });

  it("leitura da política falhando: recusa", async () => {
    await expect(
      assertMeetingDeliverySupabase(supa(null, { message: "conexao caiu" }), CONTEXTO),
    ).rejects.toMatchObject({ message: "conexao caiu" });
    const quebrado = {
      query: async () => {
        throw new Error("conexao caiu");
      },
    } as unknown as Queryable;
    await expect(assertMeetingDeliveryPg(quebrado, CONTEXTO)).rejects.toThrow("conexao caiu");
  });

  it("comando humano continua enviando: a marca cala a IA, não a pessoa", async () => {
    const p = politica({ ai_opt_out: true, force_human: true, human_command: true });
    await expect(assertMeetingDeliveryPg(pg(p), CONTEXTO)).resolves.toMatchObject({
      humanCommand: true,
    });
  });
});
