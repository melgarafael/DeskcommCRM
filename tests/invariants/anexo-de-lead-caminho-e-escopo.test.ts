/**
 * ANEXOS DE NEGÓCIO (#3229) — o caminho do arquivo e o escopo do negócio pai,
 * contra o Postgres de verdade.
 *
 * As rotas de mídia e de remoção falam com o Storage pelo cliente admin; o
 * banco é quem garante que cada linha só aponta para o que é dela:
 *   - `storage_path` preso a `{org}/leads/{lead}/{campo}/{arquivo}` da PRÓPRIA
 *     linha (outra organização, outro negócio e segmento de escape recusados);
 *   - `storage_path` não muda depois de gravado, para nenhum escritor;
 *   - leitura e escrita seguem a visibilidade do negócio pai (escopo "só os
 *     seus" não alcança anexo de negócio de colega);
 *   - reaplicar o bloco do baseline (o `update.sh`) remove as policies com os
 *     nomes antigos — permissivas somam, e uma esquecida reabriria a escrita.
 *
 * O resto (isolamento por organização, papel, poda) está em
 * `anexo-de-lead-isolamento-e-poda.test.ts`.
 */
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { countAs, lastLine, sql, writeCountAs } from "./gov-helpers";

const ORG_A = "3229a000-0000-4000-8000-00000000000a";
const ORG_B = "3229a000-0000-4000-8000-00000000000b";
const USER_A = "3229a000-1111-4000-8000-00000000000a";
const COLEGA_A = "3229a000-1111-4000-8000-0000000000a2";
const USER_B = "3229a000-1111-4000-8000-00000000000b";
const FUNIL_A = "3229a000-2222-4000-8000-00000000000a";
const FUNIL_B = "3229a000-2222-4000-8000-00000000000b";
const ETAPA_A = "3229a000-3333-4000-8000-00000000000a";
const ETAPA_B = "3229a000-3333-4000-8000-00000000000b";
const LEAD_A = "3229a000-4444-4000-8000-00000000000a";
const LEAD_DO_COLEGA = "3229a000-4444-4000-8000-0000000000a2";
const LEAD_B = "3229a000-4444-4000-8000-00000000000b";
const ANEXO_DO_COLEGA = "3229a000-5555-4000-8000-0000000000a2";
const ANEXO_B = "3229a000-5555-4000-8000-00000000000b";

const caminho = (org: string, lead: string, arquivo = "3229a000-6666-4000-8000-000000000001.pdf") =>
  `${org}/leads/${lead}/comprovante/${arquivo}`;

const RESTRICAO = "crm_lead_attachments_storage_path_check";

/** stderr do script ('' se passou). */
function erroDe(script: string): string {
  try {
    sql(script);
    return "";
  } catch (err) {
    return (err as { stderr?: string }).stderr ?? String(err);
  }
}

function comoAuthenticated(user: string, dml: string): string {
  return `
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${user}"}', false);
    ${dml};`;
}

function insereComo(user: string, lead: string, storagePath: string, fieldKey = "comprovante"): string {
  return erroDe(
    comoAuthenticated(
      user,
      `insert into crm_lead_attachments (organization_id, lead_id, field_key, file_name, storage_path)
         values ('${ORG_A}', '${lead}', '${fieldKey}', 'x.pdf', '${storagePath}')`,
    ),
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'anexo-caminho-a@invariant.test'),
      ('${COLEGA_A}', 'anexo-caminho-a2@invariant.test'),
      ('${USER_B}', 'anexo-caminho-b@invariant.test')
      on conflict do nothing;
    insert into organizations (id, slug, legal_name, display_name, settings) values
      ('${ORG_A}', 'anexo-caminho-a', 'Anexo Caminho A LTDA', 'Anexo Caminho A', jsonb_build_object('visibility_mode', 'own')),
      ('${ORG_B}', 'anexo-caminho-b', 'Anexo Caminho B LTDA', 'Anexo Caminho B', '{}'::jsonb)
      on conflict do nothing;
    insert into user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'agent', now()),
      ('${COLEGA_A}', '${ORG_A}', 'agent', now()),
      ('${USER_B}', '${ORG_B}', 'agent', now())
      on conflict do nothing;
    insert into crm_pipelines (id, organization_id, name, slug) values
      ('${FUNIL_A}', '${ORG_A}', 'Funil A', 'funil-caminho-a'),
      ('${FUNIL_B}', '${ORG_B}', 'Funil B', 'funil-caminho-b')
      on conflict do nothing;
    insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA_A}', '${ORG_A}', '${FUNIL_A}', 'Novo', 'novo', 1000),
      ('${ETAPA_B}', '${ORG_B}', '${FUNIL_B}', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id) values
      ('${LEAD_A}', '${ORG_A}', '${FUNIL_A}', '${ETAPA_A}', 'Negócio do A', '${USER_A}'),
      ('${LEAD_DO_COLEGA}', '${ORG_A}', '${FUNIL_A}', '${ETAPA_A}', 'Negócio do colega', '${COLEGA_A}'),
      ('${LEAD_B}', '${ORG_B}', '${FUNIL_B}', '${ETAPA_B}', 'Negócio do B', null)
      on conflict do nothing;
  `);
});

beforeEach(() => {
  sql(`
    delete from crm_lead_attachments where organization_id in ('${ORG_A}', '${ORG_B}');
    insert into crm_lead_attachments (id, organization_id, lead_id, field_key, file_name, storage_path) values
      ('${ANEXO_DO_COLEGA}', '${ORG_A}', '${LEAD_DO_COLEGA}', 'comprovante', 'colega.pdf',
       '${caminho(ORG_A, LEAD_DO_COLEGA, `${ANEXO_DO_COLEGA}.pdf`)}'),
      ('${ANEXO_B}', '${ORG_B}', '${LEAD_B}', 'comprovante', 'b.pdf',
       '${caminho(ORG_B, LEAD_B, `${ANEXO_B}.pdf`)}');
  `);
});

describe("crm_lead_attachments — o caminho fica preso à linha", () => {
  it("controle positivo: o caminho do próprio negócio grava", () => {
    expect(
      writeCountAs(
        USER_A,
        `insert into crm_lead_attachments (organization_id, lead_id, field_key, file_name, storage_path)
           values ('${ORG_A}', '${LEAD_A}', 'comprovante', 'x.pdf', '${caminho(ORG_A, LEAD_A)}')`,
      ),
    ).toBe(1);
  });

  it("caminho de outra organização é recusado", () => {
    expect(insereComo(USER_A, LEAD_A, caminho(ORG_B, LEAD_B, `${ANEXO_B}.pdf`))).toContain(RESTRICAO);
  });

  it("caminho de outro negócio da mesma organização é recusado", () => {
    expect(insereComo(USER_A, LEAD_A, caminho(ORG_A, LEAD_DO_COLEGA, `${ANEXO_DO_COLEGA}.pdf`))).toContain(RESTRICAO);
  });

  it("caminho de outro campo, ou que sai do prefixo por segmento, é recusado", () => {
    expect(insereComo(USER_A, LEAD_A, `${ORG_A}/leads/${LEAD_A}/outro/a.pdf`)).toContain(RESTRICAO);
    expect(
      insereComo(USER_A, LEAD_A, `${ORG_A}/leads/${LEAD_A}/comprovante/../../../${ORG_B}/leads/${LEAD_B}/comprovante/${ANEXO_B}.pdf`),
    ).toContain(RESTRICAO);
    expect(insereComo(USER_A, LEAD_A, `${ORG_A}/leads/${LEAD_A}/comprovante/..`)).toContain(RESTRICAO);
    expect(insereComo(USER_A, LEAD_A, `${ORG_A}/leads/${LEAD_A}/x/y/a.pdf`, "x/y")).toContain(RESTRICAO);
  });

  it("o caminho não muda depois de gravado — nem para quem ignora a RLS", () => {
    const outro = caminho(ORG_A, LEAD_DO_COLEGA, "3229a000-6666-4000-8000-000000000002.pdf");
    expect(erroDe(`update crm_lead_attachments set storage_path = '${outro}' where id = '${ANEXO_DO_COLEGA}';`)).toContain(
      "não muda depois de gravado",
    );
    // controle: o resto da linha continua alterável.
    expect(erroDe(`update crm_lead_attachments set file_name = 'renomeado.pdf' where id = '${ANEXO_DO_COLEGA}';`)).toBe("");
  });
});

describe("crm_lead_attachments — escopo do negócio pai", () => {
  it("no modo 'só os seus', o agent não lê anexo de negócio do colega; o dono lê", () => {
    expect(countAs(USER_A, `select count(*) from crm_lead_attachments where id = '${ANEXO_DO_COLEGA}';`)).toBe(0);
    expect(countAs(COLEGA_A, `select count(*) from crm_lead_attachments where id = '${ANEXO_DO_COLEGA}';`)).toBe(1);
  });

  it("nem anexa nem apaga no negócio do colega", () => {
    expect(
      writeCountAs(
        USER_A,
        `insert into crm_lead_attachments (organization_id, lead_id, field_key, file_name, storage_path)
           values ('${ORG_A}', '${LEAD_DO_COLEGA}', 'comprovante', 'x.pdf', '${caminho(ORG_A, LEAD_DO_COLEGA)}')`,
      ),
    ).toBe(0);
    expect(writeCountAs(USER_A, `delete from crm_lead_attachments where id = '${ANEXO_DO_COLEGA}'`)).toBe(0);
    expect(lastLine(sql(`select count(*) from crm_lead_attachments where id = '${ANEXO_DO_COLEGA}';`))).toBe("1");
  });
});

describe("crm_lead_attachments — reaplicar o baseline", () => {
  // Só as PERMISSIVAS somam (OR); as restritivas do modo suporte (support_write_*) só cortam.
  it("as policies permissivas com nomes antigos saem; ficam só as atuais", () => {
    sql(`
      drop policy if exists tenant_isolation_crm_lead_attachments_all on public.crm_lead_attachments;
      drop policy if exists crm_lead_attachments_tenant_isolate on public.crm_lead_attachments;
      create policy tenant_isolation_crm_lead_attachments_all on public.crm_lead_attachments
        for all to authenticated using (organization_id in (select public.fn_user_org_ids()));
      create policy crm_lead_attachments_tenant_isolate on public.crm_lead_attachments
        for all to authenticated using (organization_id in (select public.fn_user_org_ids()));
    `);

    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const inicio = baseline.indexOf("-- ---- anexos do campo `file` do negócio (migration 0731");
    expect(inicio).toBeGreaterThan(-1);
    const fim = baseline.indexOf("\n-- ---- ", inicio + 1);
    sql(baseline.slice(inicio, fim));

    expect(
      sql(
        `select string_agg(policyname, ',' order by policyname) from pg_policies
          where schemaname = 'public' and tablename = 'crm_lead_attachments' and permissive = 'PERMISSIVE';`,
      ),
    ).toBe("tenant_isolation_crm_lead_attachments_select,tenant_isolation_crm_lead_attachments_write");
    // e a restrição continua de pé depois da reaplicação.
    expect(insereComo(USER_A, LEAD_A, caminho(ORG_B, LEAD_B, `${ANEXO_B}.pdf`))).toContain(RESTRICAO);
  });
});
