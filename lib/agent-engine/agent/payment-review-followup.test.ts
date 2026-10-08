import { describe, expect, it, vi } from "vitest";
import {
  paymentReviewPending,
  paymentReviewPendingSupabase,
  sendUnlessPaymentReview,
  PaymentReviewPendingError,
} from "./payment-review-followup";
import type { Queryable } from "../queue/queue";
import type { SupabaseClient } from "@supabase/supabase-js";
function db(pending: boolean) {
  return { query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ pending }] })) };
}
describe("conferência de pagamento interrompe cobrança proativa", () => {
  it("consulta organização/conversa/compra e inclui a espera pela cliente", async () => {
    const d = db(true);
    expect(await paymentReviewPending(d as unknown as Queryable, "org-a", "conv-a", "lead-a")).toBe(
      true,
    );
    expect(d.query).toHaveBeenCalledWith(expect.stringContaining("task_state <> 'completed'"), [
      "org-a",
      "conv-a",
      "lead-a",
    ]);
    expect(d.query.mock.calls[0]?.[0]).toContain("lead_id=$3::uuid");
    expect(d.query.mock.calls[0]?.[0]).toContain("'awaiting_lead'");
  });
  it.each([true, false])("leitura pending=%s controla o sink do agente", async (pending) => {
    const send = vi.fn(async () => "sent");
    const d = db(pending);
    const run = sendUnlessPaymentReview(
      d as unknown as Queryable,
      { organizationId: "org", conversationId: "conv", jobKind: "followup_turn", leadId: "lead" },
      send,
    );
    if (pending) {
      await expect(run).rejects.toBeInstanceOf(PaymentReviewPendingError);
      expect(send).not.toHaveBeenCalled();
    } else {
      await expect(run).resolves.toBe("sent");
      expect(send).toHaveBeenCalledOnce();
    }
  });
  it.each(["inbound_turn", "case_reply_turn"])(
    "%s continua respondendo sem consultar a cobrança",
    async (jobKind) => {
      const d = db(true);
      const send = vi.fn(async () => "sent");
      expect(
        await sendUnlessPaymentReview(
          d as unknown as Queryable,
          { organizationId: "org", conversationId: "conv", jobKind },
          send,
        ),
      ).toBe("sent");
      expect(d.query).not.toHaveBeenCalled();
    },
  );
  it("erro de banco impede envio", async () => {
    const send = vi.fn();
    const d = { query: vi.fn().mockRejectedValue(new Error("db unavailable")) };
    await expect(
      sendUnlessPaymentReview(
        d as Queryable,
        { organizationId: "org", conversationId: "conv", jobKind: "followup_turn" },
        send,
      ),
    ).rejects.toThrow("db unavailable");
    expect(send).not.toHaveBeenCalled();
  });
  it("consulta Supabase usa os mesmos limites de organização e tarefa", async () => {
    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      neq: vi.fn(),
      in: vi.fn(),
      limit: vi.fn(async () => ({ data: [{ id: "task" }], error: null })),
    };
    for (const method of [chain.select, chain.eq, chain.neq, chain.in])
      method.mockReturnValue(chain);
    const d = { from: vi.fn(() => chain) };
    expect(
      await paymentReviewPendingSupabase(d as unknown as SupabaseClient, "org", "conv", "lead"),
    ).toBe(true);
    expect(chain.eq).toHaveBeenCalledWith("organization_id", "org");
    expect(chain.eq).toHaveBeenCalledWith("conversation_id", "conv");
    expect(chain.eq).toHaveBeenCalledWith("task_kind", "payment_review");
    expect(chain.eq).toHaveBeenCalledWith("lead_id", "lead");
    expect(chain.neq).toHaveBeenCalledWith("task_state", "completed");
  });
});
