import { describe, expect, it, vi } from "vitest";

import { createSupabaseSilenceSweepDb } from "@/lib/followup/silence-sweep";
import { createSupabaseAdminClient } from "@/lib/followup/engine";

/**
 * A 0222 criou `messages.service_revision` e `followup_enrollments.
 * service_boundary` NULOS e sem backfill. O consumidor lê ausência de carimbo
 * como fronteira VENCIDA — e numa instalação que já roda isso não degrada
 * discretamente: o acompanhamento em curso é cancelado no primeiro tick depois
 * do `update.sh` e a varredura de silêncio fica cega exatamente para quem não
 * manda mensagem nova.
 *
 * A migration carimba as linhas legadas. Estes casos guardam o CINTO: o clone
 * que já atualizou sem o backfill precisa se recuperar sozinho.
 */

function supabaseComConversas(data: unknown[]) {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (value: unknown) => unknown) => resolve({ data, error: null });
        }
        return () => chain;
      },
    },
  );
  return { from: () => chain } as never;
}

const metadata = { ai_gate: "open" };

function conversaLegada(contactId: string, comCarimbo: boolean) {
  const conversationId = `conversation-${contactId}`;
  return {
    id: conversationId,
    service_revision: 1,
    current_demanda_id: null,
    demandas: null,
    status: "open",
    contact_id: contactId,
    last_inbound_at: "2026-09-01T10:00:00.000Z",
    messages: comCarimbo
      ? [
          {
            organization_id: "org",
            contact_id: contactId,
            conversation_id: conversationId,
            service_revision: 1,
            demanda_id: null,
            demanda_revision: null,
            sent_at: "2026-09-01T10:00:00.000Z",
          },
        ]
      : [],
    contacts: { tags: [], is_blocked: false, ai_authorized_at: null, phone_number: "+5585999990000" },
    sessao: { metadata },
  };
}

describe("fronteira legada não apaga o trabalho em curso", () => {
  it("varredura de silêncio enxerga a conversa SEM carimbo (degrada para last_inbound_at)", async () => {
    const db = createSupabaseSilenceSweepDb(supabaseComConversas([conversaLegada("c-legado", false)]));
    const ids = await db.loadSilentContactIds("org", "2026-09-02T10:00:00.000Z", []);
    expect(ids).toEqual(["c-legado"]);
  });

  it("varredura de silêncio continua enxergando a conversa COM carimbo", async () => {
    const db = createSupabaseSilenceSweepDb(supabaseComConversas([conversaLegada("c-novo", true)]));
    const ids = await db.loadSilentContactIds("org", "2026-09-02T10:00:00.000Z", []);
    expect(ids).toEqual(["c-novo"]);
  });

  it("acompanhamento SEM fronteira não é lido como fronteira vencida", async () => {
    const rpc = vi.fn();
    const db = createSupabaseAdminClient({ rpc } as never);
    await expect(
      db.assertServiceBoundary!({
        id: "enr-legado",
        organization_id: "org",
        contact_id: "c-legado",
        service_boundary: null,
      } as never),
    ).resolves.toBeUndefined();
    // Ausência de carimbo é desconhecimento: nem sequer pergunta ao banco.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("acompanhamento COM fronteira continua sendo conferido contra o banco", async () => {
    // `fn_service_boundary` devolvendo nada = conversa que não existe mais.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const db = createSupabaseAdminClient({ rpc } as never);
    await expect(
      db.assertServiceBoundary!({
        id: "enr-novo",
        organization_id: "org",
        contact_id: "c-novo",
        service_boundary: {
          organization_id: "org",
          contact_id: "c-novo",
          conversation_id: "conv-1",
          service_revision: 1,
          demanda_id: null,
          demanda_revision: null,
        },
      } as never),
    ).rejects.toThrow("service_boundary_stale");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
