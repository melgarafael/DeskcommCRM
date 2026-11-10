import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * O motivo escrito por quem descarta também pode identificar o titular.
 * Executa a cascata instalada, pelos vínculos direto e crm_lead_links, com
 * controles na mesma organização e noutra. A transação desfaz toda a semente.
 * Não modifica os invariantes herdados do PR #3471.
 */
describe("propostas de campos: anonimização do motivo de recusa", () => {
  it.each(["pedido", "ficha"] as const)("%s: redige pelos dois vínculos, preserva decisão e poupa vizinhos", (via) => {
    const saida = sql(`
      begin;
      create temporary table prova_motivos_de_proposta (fase text, dados jsonb);
      do $prova$
      declare
        org_a uuid := gen_random_uuid(); org_b uuid := gen_random_uuid();
        titular uuid := gen_random_uuid(); vizinho uuid := gen_random_uuid();
        funil_a uuid := gen_random_uuid(); funil_b uuid := gen_random_uuid();
        etapa_a uuid := gen_random_uuid(); etapa_b uuid := gen_random_uuid();
        direto uuid := gen_random_uuid(); vinculado uuid := gen_random_uuid();
        outro uuid := gen_random_uuid(); outra_org uuid := gen_random_uuid();
        p_direta uuid := gen_random_uuid(); p_vinculada uuid := gen_random_uuid();
        p_vizinha uuid := gen_random_uuid(); p_outra_org uuid := gen_random_uuid();
        operador uuid := gen_random_uuid();
        repeticao jsonb;
        antes timestamptz := '2026-10-20 10:00:00+00';
      begin
        insert into public.organizations (id, slug, legal_name, display_name) values
          (org_a, 'proposta-' || org_a, 'Organização sintética A', 'Prova A'),
          (org_b, 'proposta-' || org_b, 'Organização sintética B', 'Prova B');
        insert into auth.users (id, email) values (operador, operador || '@invariant.test');
        insert into public.user_organizations (user_id, organization_id, role, accepted_at)
          values (operador, org_a, 'admin', now());
        insert into public.contacts (id, organization_id, name, display_name) values
          (titular, org_a, 'Pessoa Sintética Alvo', 'Pessoa Sintética Alvo'),
          (vizinho, org_a, 'Pessoa Sintética Vizinha', 'Pessoa Sintética Vizinha');
        insert into public.crm_pipelines (id, organization_id, name, slug) values
          (funil_a, org_a, 'Prova A', 'prova-a'), (funil_b, org_b, 'Prova B', 'prova-b');
        insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
          (etapa_a, org_a, funil_a, 'Entrada', 'entrada', 1000),
          (etapa_b, org_b, funil_b, 'Entrada', 'entrada', 1000);
        insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title) values
          (direto, org_a, funil_a, etapa_a, titular, 'Negócio direto'),
          (vinculado, org_a, funil_a, etapa_a, null, 'Negócio com vínculo'),
          (outro, org_a, funil_a, etapa_a, vizinho, 'Negócio vizinho'),
          (outra_org, org_b, funil_b, etapa_b, null, 'Negócio de outra organização');
        insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
          values (org_a, vinculado, 'contact', titular, 'related');
        insert into public.lead_field_proposals
          (id, organization_id, lead_id, campo, valor_proposto, valor_anterior, trecho,
           motivo_recusa, status, expires_at, decided_at)
        values
          (p_direta, org_a, direto, 'localizador', '"ABC123"', '"DEF456"',
           'Trecho da Pessoa Sintética Alvo', 'Nome da Pessoa Sintética Alvo está errado',
           'dismissed', now() + interval '7 days', antes),
          (p_vinculada, org_a, vinculado, 'localizador', '"ABC123"', '"DEF456"',
           'Trecho da Pessoa Sintética Alvo', 'Localizador da Pessoa Sintética Alvo está errado',
           'dismissed', now() + interval '7 days', antes),
          (p_vizinha, org_a, outro, 'localizador', '"VIZ123"', null, 'Trecho vizinho',
           'Motivo vizinho', 'dismissed', now() + interval '7 days', antes),
          (p_outra_org, org_b, outra_org, 'localizador', '"ORG123"', null, 'Trecho outra org',
           'Motivo outra org', 'dismissed', now() + interval '7 days', antes);

        insert into prova_motivos_de_proposta values ('antes', jsonb_build_object(
          'propostas', (select count(*) from public.lead_field_proposals
                         where id in (p_direta, p_vinculada, p_vizinha, p_outra_org)),
          'motivos_alvo', (select count(*) from public.lead_field_proposals
                            where id in (p_direta, p_vinculada) and motivo_recusa like '%Pessoa Sintética Alvo%')
        ));
        perform set_config('request.jwt.claims', jsonb_build_object('sub', operador, 'aal', 'aal2')::text, true);
        if '${via}' = 'ficha' then
          execute 'set local role authenticated';
          perform public.fn_lgpd_anonymize_contact(org_a, titular);
          select public.fn_lgpd_anonymize_contact(org_a, titular) into repeticao;
        else
          execute 'set local role service_role';
          perform public.fn_lgpd_cascade_redact_contact(org_a, titular, null);
          select public.fn_lgpd_cascade_redact_contact(org_a, titular, null) into repeticao;
        end if;
        execute 'reset role';
        insert into prova_motivos_de_proposta values ('depois', jsonb_build_object(
          'alvos_redigidos', (select count(*) from public.lead_field_proposals p
            join public.contacts c on c.id = titular
            where p.id in (p_direta, p_vinculada) and p.motivo_recusa is null
              and p.valor_proposto is null and p.valor_anterior is null and p.trecho = c.name),
          'decisoes_preservadas', (select count(*) from public.lead_field_proposals
            where id in (p_direta, p_vinculada) and status = 'dismissed' and decided_at = antes),
          'vizinho_preservado', (select motivo_recusa from public.lead_field_proposals where id = p_vizinha),
          'outra_org_preservada', (select motivo_recusa from public.lead_field_proposals where id = p_outra_org),
          'repeticao_sem_efeito', repeticao->'already_anonymized'
        ));
      end $prova$;
      select jsonb_object_agg(fase, dados) from prova_motivos_de_proposta;
      rollback;
    `);
    const linha = saida.split("\n").find((l) => l.startsWith("{"));
    expect(linha, "a prova não devolveu o retrato antes/depois").toBeDefined();
    expect(JSON.parse(linha!)).toEqual({
      antes: { propostas: 4, motivos_alvo: 2 },
      depois: {
        alvos_redigidos: 2,
        decisoes_preservadas: 2,
        vizinho_preservado: "Motivo vizinho",
        outra_org_preservada: "Motivo outra org",
        repeticao_sem_efeito: true,
      },
    });
  });

  it("a cascata permanece executável somente pelo servidor", () => {
    const permissao = sql(`select jsonb_build_object(
      'anon', has_function_privilege('anon', 'public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)', 'execute'),
      'authenticated', has_function_privilege('authenticated', 'public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)', 'execute'),
      'service_role', has_function_privilege('service_role', 'public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)', 'execute')
    );`);
    expect(JSON.parse(permissao)).toEqual({ anon: false, authenticated: false, service_role: true });
  });
});
