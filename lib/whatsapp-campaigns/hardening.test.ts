import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { classifySendError } from "@/lib/whatsapp-campaigns/classify-error";
import { isProviderAccepted } from "@/lib/whatsapp-campaigns/send";
import type { Message } from "@/lib/types/messaging";

describe("classifySendError hardening", () => {
  it("timeout/abort → uncertain (não retry automático)", () => {
    const r = classifySendError(new Error("Timeout waiting for WAHA"));
    expect(r.uncertain).toBe(true);
    expect(r.permanent).toBe(false);
    expect(r.code).toBe("provider_uncertain");
  });

  it("waha_500 → transient retryável", () => {
    const r = classifySendError(new Error("waha_500"));
    expect(r.uncertain).toBe(false);
    expect(r.permanent).toBe(false);
    expect(r.code).toBe("transient");
  });

  it("waha_400 → permanente", () => {
    const r = classifySendError(new Error("waha_400"));
    expect(r.permanent).toBe(true);
  });

  it("opt-out/blocked → permanente", () => {
    expect(classifySendError(new Error("opt_out")).permanent).toBe(true);
    expect(classifySendError(new Error("blocked")).permanent).toBe(true);
  });
});

describe("isProviderAccepted", () => {
  it("exige status aceito + external_id", () => {
    expect(
      isProviderAccepted({ status: "sent", external_id: "x" } as Message),
    ).toBe(true);
    expect(
      isProviderAccepted({ status: "sent", external_id: null } as Message),
    ).toBe(false);
    expect(
      isProviderAccepted({ status: "queued", external_id: null } as Message),
    ).toBe(false);
    expect(
      isProviderAccepted({ status: "failed", external_id: null } as Message),
    ).toBe(false);
  });
});

describe("hardening migration 0241 contrato", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260924200000_0241_whatsapp_campaigns_hardening.sql"),
    "utf8",
  );

  it("define send_uncertain", () => {
    expect(sql).toContain("send_uncertain");
  });

  it("tem recover stale claims só service_role", () => {
    expect(sql).toContain("fn_recover_stale_whatsapp_campaign_claims");
    expect(sql).toMatch(
      /revoke execute on function public\.fn_recover_stale_whatsapp_campaign_claims[\s\S]*from public, anon, authenticated/i,
    );
  });

  it("claim rotaciona outbound após message failed", () => {
    expect(sql).toMatch(/m\.status = 'failed'/);
    expect(sql).toMatch(/v_msg_id := gen_random_uuid\(\)/);
  });

  it("stats agregadas via fn_whatsapp_campaign_status_counts", () => {
    expect(sql).toContain("fn_whatsapp_campaign_status_counts");
  });
});

describe("worker-tick pause gate source", () => {
  it("assertStillRunnable existe e é chamado antes do envio", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/whatsapp-campaigns/worker-tick.ts"),
      "utf8",
    );
    expect(src).toContain("export async function assertStillRunnable");
    expect(src).toContain("Gate final imediatamente antes do HTTP externo");
    expect(src).toContain("assertStillRunnable(pool, claimed)");
    expect(src).toContain("send_uncertain");
    expect(src).toContain("fn_recover_stale_whatsapp_campaign_claims");
  });

  it("completion trata send_uncertain como aberto (não completa)", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/whatsapp-campaigns/worker-tick.ts"),
      "utf8",
    );
    expect(src).toMatch(
      /status in \('pending','scheduled','processing','send_uncertain'\)/,
    );
  });

  it("sync ACK de send_uncertain exige external_id (não inventa confirmação)", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/whatsapp-campaigns/worker-tick.ts"),
      "utf8",
    );
    expect(src).toContain("and m.external_id is not null");
    expect(src).toContain("provider_ack");
  });
});

describe("WAHA sendText sem chave de idempotência no cliente", () => {
  it("client.sendMessage não envia idempotency_key/clientMessageId", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/waha/client.ts"), "utf8");
    const sendBlock = src.slice(
      src.indexOf("async sendMessage("),
      src.indexOf("async setPresence("),
    );
    expect(sendBlock).toContain("/api/sendText");
    expect(sendBlock).not.toMatch(/idempotency/i);
    expect(sendBlock).not.toMatch(/clientMessageId/i);
    expect(sendBlock).toContain("session, chatId, text");
  });
});
