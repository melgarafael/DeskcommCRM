import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
}));

import { resolveUncertainSchema } from "@/lib/whatsapp-campaigns/resolve-uncertain";

const USER = "aaaaaaaa-1111-4000-8000-000000000099";
const ORG = "aaaaaaaa-0000-4000-8000-000000000099";
const CAMP = "aaaaaaaa-2222-4000-8000-000000000099";
const REC = "aaaaaaaa-3333-4000-8000-000000000099";

describe("resolveUncertainSchema", () => {
  it("aceita assume_sent e retry_anyway", () => {
    expect(resolveUncertainSchema.parse({ resolution: "assume_sent" }).resolution).toBe(
      "assume_sent",
    );
    expect(resolveUncertainSchema.parse({ resolution: "retry_anyway" }).resolution).toBe(
      "retry_anyway",
    );
  });

  it("rejeita resolução genérica / requeue", () => {
    expect(() => resolveUncertainSchema.parse({ resolution: "pending" })).toThrow();
    expect(() => resolveUncertainSchema.parse({ resolution: "requeue" })).toThrow();
  });
});

describe("send_uncertain nunca requeue automático — fonte", () => {
  it("claim SQL não seleciona send_uncertain", () => {
    const m241 = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260924200000_0241_whatsapp_campaigns_hardening.sql",
      ),
      "utf8",
    );
    expect(m241).toMatch(/r\.status in \('pending', 'scheduled', 'failed'\)/);
  });

  it("stale recovery só toca processing + guarda anti-requeue", () => {
    const m242 = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260924210000_0242_whatsapp_campaign_uncertain_resolution.sql",
      ),
      "utf8",
    );
    expect(m242).toContain("where r.status = 'processing'  -- nunca send_uncertain");
    expect(m242).toContain("fn_whatsapp_campaign_recipients_guard_uncertain");
    expect(m242).toContain("assumed_sent");
    expect(m242).toContain("retry_anyway");
  });

  it("cancel handler não cancela send_uncertain", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/whatsapp-campaigns/handlers.ts"),
      "utf8",
    );
    expect(src).toMatch(/\.in\("status", \["pending", "scheduled"\]\)/);
  });

  it("resume não mexe em recipients", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/whatsapp-campaigns/handlers.ts"),
      "utf8",
    );
    const resume = src.slice(
      src.indexOf("resumeCampaignHandler"),
      src.indexOf("cancelCampaignHandler"),
    );
    expect(resume).not.toContain("whatsapp_campaign_recipients");
  });
});

/** Builder fluent que devolve `self` em qualquer encadeamento. */
function fluent(terminal: unknown) {
  const api: Record<string, unknown> = {};
  const ret = () => api;
  for (const m of ["select", "eq", "update", "insert", "order", "limit", "neq", "is"]) {
    api[m] = ret;
  }
  // `.in()` é thenable próprio: listagens (completion) precisam de array em `data`.
  api.in = () => {
    const list = {
      then: (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
      maybeSingle: async () => terminal,
    };
    return list;
  };
  api.maybeSingle = async () => terminal;
  api.single = async () => terminal;
  api.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(terminal).then(onFulfilled, onRejected);
  return api;
}

describe("resolveUncertainRecipientHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assume_sent não chama sendCampaignMessage", async () => {
    const sendMod = await import("@/lib/whatsapp-campaigns/send");
    const spy = vi.spyOn(sendMod, "sendCampaignMessage");

    const updates: unknown[] = [];
    const inserts: string[] = [];
    const recipient = {
      id: REC,
      status: "send_uncertain",
      outbound_message_id: "aaaaaaaa-4444-4000-8000-000000000001",
      message_id: null,
      attempt_count: 1,
      channel_session_id: "aaaaaaaa-5555-4000-8000-000000000001",
    };

    const supabase = {
      from(table: string) {
        if (table === "whatsapp_campaign_recipients") {
          return {
            select: () => fluent({ data: recipient, error: null }),
            update: (payload: unknown) => {
              updates.push(payload);
              return fluent({ data: { id: REC, ...((payload as object) ?? {}) }, error: null });
            },
          };
        }
        inserts.push(table);
        return {
          insert: () => Promise.resolve({ error: null }),
          update: () => fluent({ data: { id: CAMP }, error: null }),
          select: () => fluent({ data: [], error: null }),
        };
      },
    };

    const { resolveUncertainRecipientHandler } = await import(
      "@/lib/whatsapp-campaigns/resolve-uncertain"
    );
    const result = await resolveUncertainRecipientHandler(
      supabase as never,
      {
        organization_id: ORG,
        requestId: "req-1",
        actor: { type: "user", id: USER },
      },
      USER,
      CAMP,
      REC,
      { resolution: "assume_sent" },
    );

    expect(result.status).toBe("assumed_sent");
    expect(spy).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({
      status: "assumed_sent",
      uncertainty_resolution: "assume_sent",
    });
    expect(inserts).toContain("whatsapp_campaign_uncertainty_resolutions");
    spy.mockRestore();
  });

  it("retry_anyway gera novo outbound e pending", async () => {
    const updates: unknown[] = [];
    const recipient = {
      id: REC,
      status: "send_uncertain",
      outbound_message_id: "aaaaaaaa-4444-4000-8000-0000000000aa",
      message_id: "aaaaaaaa-6666-4000-8000-000000000001",
      attempt_count: 2,
      channel_session_id: "aaaaaaaa-5555-4000-8000-000000000001",
    };

    const supabase = {
      from(table: string) {
        if (table === "whatsapp_campaign_recipients") {
          return {
            select: () => fluent({ data: recipient, error: null }),
            update: (payload: unknown) => {
              updates.push(payload);
              return fluent({ data: { id: REC, ...((payload as object) ?? {}) }, error: null });
            },
          };
        }
        return {
          insert: () => Promise.resolve({ error: null }),
          update: () => fluent({ data: null, error: null }),
          select: () => fluent({ data: [], error: null }),
        };
      },
    };

    const { resolveUncertainRecipientHandler } = await import(
      "@/lib/whatsapp-campaigns/resolve-uncertain"
    );
    const result = await resolveUncertainRecipientHandler(
      supabase as never,
      {
        organization_id: ORG,
        requestId: "req-1",
        actor: { type: "user", id: USER },
      },
      USER,
      CAMP,
      REC,
      { resolution: "retry_anyway", note: "aceito risco" },
    );

    expect(result.status).toBe("pending");
    expect(result.uncertainty_resolution).toBe("retry_anyway");
    expect((updates[0] as { outbound_message_id: string }).outbound_message_id).not.toBe(
      "aaaaaaaa-4444-4000-8000-0000000000aa",
    );
  });
});
