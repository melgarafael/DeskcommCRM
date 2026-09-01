import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * LGPD — `appointments` não guarda PII em texto livre; a anonimização do
 * lead/contato (via `fn_lgpd_cascade_redact_contact`) é suficiente para que
 * qualquer consulta que junte `appointments` a `crm_leads` veja o nome já
 * anonimizado. Este teste prova isso plantando um agendamento, redigindo o
 * contato, e conferindo que o JOIN não revela o nome original em lugar nenhum.
 *
 * `fn_lgpd_cascade_redact_contact(p_organization_id, p_contact_id, p_request_id)`
 * (supabase/baseline.sql) não toca `appointments` diretamente — ela redige
 * `crm_leads.title` (passo 5 da cascata) para 'Cliente Anonimizado #xxxxxxxx'.
 * Como `appointments` não duplica nome/telefone (só guarda `lead_id`), o JOIN
 * appointments→crm_leads herda a anonimização de graça. Este teste prova que
 * essa herança realmente se sustenta.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

describe("LGPD — appointments herda a anonimização do lead", () => {
  it("após redact do contato, o join appointments→crm_leads não mostra o nome original", () => {
    const out = sql(`
      do $$
      declare
        v_org uuid := gen_random_uuid();
        v_contact uuid := gen_random_uuid();
        v_pipeline uuid := gen_random_uuid();
        v_stage uuid := gen_random_uuid();
        v_lead uuid := gen_random_uuid();
        v_type uuid := gen_random_uuid();
        v_user uuid := gen_random_uuid();
        v_appt uuid := gen_random_uuid();
        v_request uuid := gen_random_uuid();
      begin
        insert into organizations (id, slug, legal_name, display_name)
          values (v_org, 'org-lgpd-appt-inv', 'X', 'X');
        -- appointment_types/appointments referenciam auth.users(id) via
        -- responsible_user_id/created_by_user_id — precisa existir de verdade.
        insert into auth.users (id, email) values (v_user, 'lgpd-appt-invariant@invariant.test');
        insert into contacts (id, organization_id, display_name) values (v_contact, v_org, 'Fulano de Tal');
        -- crm_leads exige pipeline_id/stage_id NOT NULL — sem isso o insert do
        -- lead falha antes de chegar perto do appointment.
        insert into crm_pipelines (id, organization_id, name, slug)
          values (v_pipeline, v_org, 'Pipeline LGPD Appt', 'pipeline-lgpd-appt-inv');
        insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
          values (v_stage, v_org, v_pipeline, 'Novo', 'novo', 1000);
        insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title)
          values (v_lead, v_org, v_pipeline, v_stage, v_contact, 'Fulano de Tal');
        insert into appointment_types (id, organization_id, name, duration_minutes, responsible_user_id)
          values (v_type, v_org, 'Consulta', 30, v_user);
        insert into appointments (id, organization_id, lead_id, appointment_type_id, responsible_user_id, scheduled_at, duration_minutes, created_by_user_id)
          values (v_appt, v_org, v_lead, v_type, v_user, now() + interval '1 day', 30, v_user);
        perform fn_lgpd_cascade_redact_contact(v_org, v_contact, v_request);
      end $$;

      select l.title
        from appointments a
        join crm_leads l on l.id = a.lead_id
       where a.organization_id = (select id from organizations where slug = 'org-lgpd-appt-inv');
    `);
    expect(out).not.toContain("Fulano de Tal");
    expect(out).toMatch(/Cliente Anonimizado/);
  });
});
