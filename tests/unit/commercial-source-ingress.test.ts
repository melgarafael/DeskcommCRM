import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const consolidated = readFileSync("supabase/migrations/20261104162935_9106_contexto_privado_e_escopos_optativos.sql", "utf8");
const migration = consolidated.split("-- contrato preservado: 0902\n")[1]?.split("-- contrato preservado:")[0] ?? "";
const baseline = readFileSync("supabase/baseline.sql", "utf8");

describe("contrato estrutural do ingresso comercial sem conversa (não substitui SQL real)", () => {
  it("entrega o mesmo SQL no baseline", () => {
    expect(baseline).toContain(consolidated);
    expect(migration).not.toBe("");
  });
  it("usa binding explícito e mesma organização, nunca primeiro canal por funil", () => {
    expect(migration).toContain("where organization_id=p_org and source_id=source_uuid");
    expect(migration).toContain("channel_id=b.rule_channel_id for update");
    expect(migration).not.toContain("limit 1");
  });
  it("não cria conversa nem substitui executor", () => {
    expect(migration).not.toMatch(/insert into public\.conversations|update public\.conversations/);
    expect(migration).not.toMatch(/set owner_user_id|set owner_agent_id|bot_silenced_until/);
    expect(migration).toContain("set commercial_owner_user_id=recipient");
  });
  it("recibo durável impede ressorteio e pending permite reavaliar", () => {
    expect(migration).toContain("status='assigned') then return");
    expect(migration).toContain("pending_no_eligible");
    expect(migration).toContain("on conflict(organization_id,lead_id) do update");
    expect(migration).toContain("exception when others then");
  });
  it("RPC administrativa exige organização e suporte gravável", () => {
    expect(migration).toContain(
      "not public.fn_role_at_least(p_org,'admin') or not public.fn_support_write_allowed(p_org)",
    );
    expect(migration).toContain("from public,anon");
    expect(migration).toContain("enable row level security");
  });
});
