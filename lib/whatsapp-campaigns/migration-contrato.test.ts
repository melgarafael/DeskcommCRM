/**
 * Invariantes de isolamento / claim documentados como testes de contrato
 * (sem Postgres). O SQL real é exercitado em pnpm test:db quando Docker existe.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260924190000_0240_whatsapp_campaigns.sql",
);

describe("whatsapp campaigns migration contrato", () => {
  const sql = fs.readFileSync(MIGRATION, "utf8");

  it("tem unique campaign_id+contact_id", () => {
    expect(sql).toMatch(/unique \(campaign_id, contact_id\)/i);
  });

  it("claim usa FOR UPDATE SKIP LOCKED", () => {
    expect(sql).toMatch(/for update of r skip locked/i);
    expect(sql).toMatch(/for update of c skip locked/i);
  });

  it("lease por channel_session", () => {
    expect(sql).toMatch(/whatsapp_campaign_session_leases/);
    expect(sql).toMatch(/channel_session_id uuid primary key|primary key \(channel_session_id\)|channel_session_id uuid not null primary key/i);
  });

  it("RLS em todas as tabelas de campanha", () => {
    for (const t of [
      "whatsapp_campaigns",
      "whatsapp_campaign_recipients",
      "whatsapp_campaign_attempts",
      "whatsapp_campaign_session_leases",
    ]) {
      expect(sql).toContain(`enable row level security`);
      expect(sql).toContain(`tenant_isolation_${t}_all`);
    }
  });

  it("claim RPC só para service_role", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.fn_claim_whatsapp_campaign_recipient[\s\S]*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.fn_claim_whatsapp_campaign_recipient[\s\S]*to service_role/i,
    );
  });

  it("triggers same-org para session/contact/recipient", () => {
    expect(sql).toContain("fn_whatsapp_campaigns_same_org");
    expect(sql).toContain("fn_whatsapp_campaign_recipients_same_org");
    expect(sql).toContain("fn_whatsapp_campaign_attempts_same_org");
  });
});

describe("campaign send reusa handler canônico", () => {
  it("send.ts importa sendMessageHandler", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/whatsapp-campaigns/send.ts"),
      "utf8",
    );
    expect(src).toContain('from "@/app/api/v1/messages/_handler"');
    expect(src).toContain("internalMessageId");
    expect(src).toContain("outboundMessageId");
  });

  it("worker não chama /api/sendText direto", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/whatsapp-campaigns/worker-tick.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/sendText|\/api\/send/);
    expect(src).toContain("sendCampaignMessage");
  });
});
