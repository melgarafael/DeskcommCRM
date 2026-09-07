import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ApprovedReplyReceiptPersistenceError,
  recordApprovedReplyReceiptSupabase,
} from "@/lib/ai/replies/delivery";
import { sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";

it.each(["returned", "rejected"])(
  "resposta RPC perdida (%s) preserva accepted e replay não envia novamente",
  async (mode) => {
    let accepted = false;
    const rpc = vi.fn(async () => {
      // The transaction committed its message and ledger before the response disappeared.
      accepted = true;
      if (mode === "rejected") throw new Error("connection reset");
      return { data: null, error: { message: "response lost" } };
    });
    const db = { rpc } as unknown as SupabaseClient;
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => {
        throw { code: "23505" };
      }),
      find: vi.fn(async () => ({
        id: "ledger",
        status: accepted ? ("accepted" as const) : ("requested" as const),
        crm_message_id: accepted ? "message" : null,
      })),
      rotate: vi.fn(async () => "rotated"),
      message: vi.fn(async () => null),
      update: vi.fn(async () => {}),
    };
    const intent = { tenantId: "org", leadId: "contact", jobId: "job", seq: 1, body: "Approved" };
    const send = vi.fn(async () => {
      await recordApprovedReplyReceiptSupabase(
        db,
        {
          organizationId: "org",
          jobId: "job",
          jobClaim: { worker_id: "worker", acquired_at: "2026-09-06T12:00:00Z" },
        },
        "message",
        "external",
        [],
      );
      return { id: "message", status: "sent" };
    });
    await expect(sendWithLedger(store, intent, send)).rejects.toBeInstanceOf(
      ApprovedReplyReceiptPersistenceError,
    );
    expect(store.update).not.toHaveBeenCalled();
    expect(await sendWithLedger(store, intent, send)).toMatchObject({
      kind: "already_sent",
      crmMessageId: "message",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.rotate).not.toHaveBeenCalled();
  },
);
