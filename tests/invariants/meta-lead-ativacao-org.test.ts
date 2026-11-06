import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

beforeAll(seedGov);

const OUTRA_ORG = "1ead6000-0000-4000-8000-000000000001";

describe("ativação causal Meta por organização", () => {
  it("migration 0804 também reaplica após o baseline", () => {
    const migration = readFileSync(
      "supabase/migrations/20261026191001_0804_ativacao_meta_lead_por_org.sql",
      "utf8",
    );
    const out = sql(`begin; ${migration}
      select 'coluna=' || count(*) from information_schema.columns
        where table_schema='public' and table_name='organizations'
          and column_name='meta_lead_birth_enabled_at';
      rollback;`);
    expect(out).toContain("coluna=1");
  });

  it("nasce desligada, usa relógio do banco e não toca em settings nem outra organização", () => {
    const out = sql(`begin;
      insert into public.organizations (id,slug,legal_name,display_name)
        values ('${OUTRA_ORG}','outra-org-ativacao','Outra Org','Outra Org');
      update public.organizations set settings = '{"conversions":{"report_via_channel":true},"routing":{"mode":"manual"}}'::jsonb
        where id='${GOV_ORG}';
      select 'antes=' || (meta_lead_birth_enabled_at is null)::text
        from public.organizations where id='${GOV_ORG}';
      create temporary table corte as
        select public.fn_definir_meta_lead_birth('${GOV_ORG}', true) as em;
      select 'ligado=' || (o.meta_lead_birth_enabled_at = c.em)::text
        || ':' || (c.em <= clock_timestamp())::text
        || ':' || (o.settings->'conversions'->>'report_via_channel' = 'true')::text
        || ':' || (o.settings->'routing'->>'mode' = 'manual')::text
        from public.organizations o cross join corte c where o.id='${GOV_ORG}';
      select 'outra=' || (meta_lead_birth_enabled_at is null)::text
        from public.organizations where id='${OUTRA_ORG}';
      select public.fn_definir_meta_lead_birth('${GOV_ORG}', false);
      select 'reativacao=' || (public.fn_definir_meta_lead_birth('${GOV_ORG}', true) > c.em)::text
        from corte c;
      select public.fn_definir_meta_lead_birth('${GOV_ORG}', false);
      select 'desligado=' || (meta_lead_birth_enabled_at is null)::text
        || ':' || (settings->'conversions'->>'report_via_channel' = 'true')::text
        from public.organizations where id='${GOV_ORG}';
      rollback;`);
    expect(out).toContain("antes=true");
    expect(out).toContain("ligado=true:true:true:true");
    expect(out).toContain("outra=true");
    expect(out).toContain("reativacao=true");
    expect(out).toContain("desligado=true:true");
  });

  it("só service_role pode executar a função", () => {
    const out = sql(`select 'grants=' ||
      has_function_privilege('service_role', 'public.fn_definir_meta_lead_birth(uuid,boolean)', 'execute')::text || ':' ||
      has_function_privilege('authenticated', 'public.fn_definir_meta_lead_birth(uuid,boolean)', 'execute')::text || ':' ||
      has_function_privilege('anon', 'public.fn_definir_meta_lead_birth(uuid,boolean)', 'execute')::text;`);
    expect(out).toBe("grants=true:false:false");
  });
});
