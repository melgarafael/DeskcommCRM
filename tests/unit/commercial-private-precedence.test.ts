import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const consolidated = readFileSync("supabase/migrations/20261104162935_9106_contexto_privado_e_escopos_optativos.sql", "utf8");
const migration = consolidated.split("-- contrato preservado: 0903\n")[1]?.split("-- contrato preservado:")[0] ?? "";
const baseline = readFileSync("supabase/baseline.sql", "utf8");

describe("cercas da precedência comercial privada (runtime RLS provado separadamente)", () => {
  it("entrega a correção no baseline sem editar migration anterior", () => {
    expect(baseline).toContain(consolidated);
    expect(migration).not.toBe("");
    expect(migration).toContain("-- manifest:");
  });
  it("prioriza comercial só no opt-in e preserva supervisão", () => {
    expect(migration).toContain("not public.fn_is_platform_admin()");
    expect(migration).toContain("public.fn_contact_context_private(p_org)");
    expect(migration).toContain("public.fn_user_role_in_org(p_org)='agent'");
    expect(migration).toContain("then l.commercial_owner_user_id=auth.uid()");
    expect(migration).toContain("else public.fn_can_view_lead(p_org,l.owner_user_id)");
  });
  it("não resolve privacidade trocando executor ou assumindo conversa", () => {
    expect(migration).not.toMatch(/update public\.(crm_leads|conversations)|set owner_user_id/);
    expect(migration).toContain("public.fn_acl_pipeline(p_org,l.pipeline_id)");
    expect(migration).toContain("public.fn_acl_channel(p_org,c.channel_session_id)");
  });
  it("delimita filhos e itens de proposta também sem escopo individual", () => {
    expect(migration).toContain("commercial_private_insert");
    expect(migration).toContain("as restrictive for insert to authenticated with check(");
    expect(migration).toContain("commercial_private_parent");
    expect(migration).toContain("commercial_private_proposal_parent");
    expect(migration).toContain("commercial_private_observer");
    expect(migration).toContain("'crm_lead_activities','crm_lead_links','crm_proposals','crm_tasks'");
    expect(migration).toContain("from public,anon");
  });
});
