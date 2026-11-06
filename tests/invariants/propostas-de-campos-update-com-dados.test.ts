import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/** Uma instalação que aplicou a 0772 pode já ter anonimizados com motivo legível. */
describe("propostas: atualização sobre dados da migration original", () => {
  it("corrige o motivo legado de contato já anonimizado sem exigir nova anonimização", () => {
    const original = readFileSync(join(process.cwd(), "supabase/migrations/20261026140000_0772_fila_de_proposta_de_campos_do_negocio.sql"), "utf8");
    const correcao = readFileSync(join(process.cwd(), "supabase/migrations/20261026190000_0797_propostas_de_campos_redigem_motivo_recusa.sql"), "utf8");
    const legado = readFileSync(join(process.cwd(), "supabase/migrations/20261026191100_0807_propostas_de_campos_vinculo_e_legado.sql"), "utf8");
    const saida = sql(`
      begin;
      ${original}
      create temporary table prova_update_propostas (fase text, dados jsonb);
      create temporary table alvo_update_propostas (
        org uuid, contato uuid, direta uuid, vinculada uuid, vizinha uuid, outra_org uuid,
        anon_em timestamptz, rotulo text
      );
      do $prova$
      declare
        org uuid := gen_random_uuid(); org_b uuid := gen_random_uuid();
        contato uuid := gen_random_uuid(); vizinho uuid := gen_random_uuid();
        contato_b uuid := gen_random_uuid(); funil uuid := gen_random_uuid();
        etapa uuid := gen_random_uuid(); funil_b uuid := gen_random_uuid();
        etapa_b uuid := gen_random_uuid(); negocio uuid := gen_random_uuid();
        vinculado uuid := gen_random_uuid(); negocio_vizinho uuid := gen_random_uuid();
        negocio_b uuid := gen_random_uuid(); direta uuid := gen_random_uuid();
        vinculada uuid := gen_random_uuid(); proposta_vizinha uuid := gen_random_uuid();
        proposta_b uuid := gen_random_uuid();
      begin
        insert into public.organizations (id,slug,legal_name,display_name)
          values (org,'proposta-' || org,'Empresa sintética A','Prova update A'),
                 (org_b,'proposta-' || org_b,'Empresa sintética B','Prova update B');
        insert into public.contacts (id,organization_id,name,display_name)
          values (contato,org,'Pessoa Sintética Legada','Pessoa Sintética Legada'),
                 (vizinho,org,'Pessoa Sintética Vizinha','Pessoa Sintética Vizinha'),
                 (contato_b,org_b,'Pessoa Sintética Outra Org','Pessoa Sintética Outra Org');
        insert into public.crm_pipelines (id,organization_id,name,slug)
          values (funil,org,'Prova update A','prova-update'),
                 (funil_b,org_b,'Prova update B','prova-update');
        insert into public.crm_stages (id,organization_id,pipeline_id,name,slug,position)
          values (etapa,org,funil,'Entrada','entrada',1000),
                 (etapa_b,org_b,funil_b,'Entrada','entrada',1000);
        insert into public.crm_leads (id,organization_id,pipeline_id,stage_id,contact_id,title)
          values (negocio,org,funil,etapa,contato,'Documento sintético direto'),
                 (vinculado,org,funil,etapa,null,'Documento sintético vinculado'),
                 (negocio_vizinho,org,funil,etapa,vizinho,'Documento sintético vizinho'),
                 (negocio_b,org_b,funil_b,etapa_b,contato_b,'Documento sintético outra org');
        insert into public.crm_lead_links (organization_id,lead_id,target_kind,target_id,link_kind)
          values (org,vinculado,'contact',contato,'related');
        insert into public.lead_field_proposals
          (id,organization_id,lead_id,campo,valor_proposto,trecho,motivo_recusa,status,decided_at,expires_at)
          values (direta,org,negocio,'localizador','"ABC123"','Trecho sintético direto',
            'Motivo direto da Pessoa Sintética Legada','dismissed','2026-10-20 10:00:00+00',now()+interval '7 days'),
            (vinculada,org,vinculado,'localizador','"ABC123"','Trecho sintético vinculado',
            'Motivo vinculado da Pessoa Sintética Legada','dismissed','2026-10-20 10:00:00+00',now()+interval '7 days'),
            (proposta_vizinha,org,negocio_vizinho,'localizador','"VIZ123"','Trecho sintético vizinho',
            'Motivo vizinho','dismissed','2026-10-20 10:00:00+00',now()+interval '7 days'),
            (proposta_b,org_b,negocio_b,'localizador','"ORG123"','Trecho sintético outra org',
            'Motivo outra org','dismissed','2026-10-20 10:00:00+00',now()+interval '7 days');
        perform public.fn_lgpd_cascade_redact_contact(org,contato,null);
        insert into alvo_update_propostas select org,contato,direta,vinculada,proposta_vizinha,proposta_b,
          anonymized_at,name from public.contacts where id=contato;
        insert into prova_update_propostas values ('antes', jsonb_build_object(
          'anonimizado',(select is_anonymized from public.contacts where id=contato),
          'motivos_legiveis',(select count(*) from public.lead_field_proposals
            where id in (direta,vinculada) and motivo_recusa is not null)
        ));
      end $prova$;
      ${correcao}
      ${legado}
      insert into prova_update_propostas select 'depois', jsonb_build_object(
        'propostas_preservadas',(select count(*) from public.lead_field_proposals p
          where p.id in (a.direta,a.vinculada,a.vizinha,a.outra_org)),
        'alvos_redigidos',(select count(*) from public.lead_field_proposals p
          where p.id in (a.direta,a.vinculada) and p.motivo_recusa is null
            and p.valor_proposto is null and p.valor_anterior is null and p.trecho=a.rotulo),
        'decisoes_preservadas',(select count(*) from public.lead_field_proposals p
          where p.id in (a.direta,a.vinculada) and p.status='dismissed'
            and p.decided_at='2026-10-20 10:00:00+00'),
        'anonimizacao_preservada',(select c.anonymized_at=a.anon_em and c.name=a.rotulo
          from public.contacts c where c.id=a.contato),
        'vizinha_preservada',(select p.motivo_recusa='Motivo vizinho' and p.valor_proposto='"VIZ123"'::jsonb
          and p.trecho='Trecho sintético vizinho' from public.lead_field_proposals p where p.id=a.vizinha),
        'outra_org_preservada',(select p.motivo_recusa='Motivo outra org' and p.valor_proposto='"ORG123"'::jsonb
          and p.trecho='Trecho sintético outra org' from public.lead_field_proposals p where p.id=a.outra_org)
      ) from alvo_update_propostas a;
      select jsonb_object_agg(fase,dados) from prova_update_propostas;
      rollback;
    `);
    const linha = saida.split("\n").find((l) => l.startsWith("{"));
    expect(linha, "a prova de atualização não produziu o retrato antes/depois").toBeDefined();
    expect(JSON.parse(linha!)).toEqual({
      antes: { anonimizado: true, motivos_legiveis: 2 },
      depois: {
        propostas_preservadas: 4, alvos_redigidos: 2, decisoes_preservadas: 2,
        anonimizacao_preservada: true, vizinha_preservada: true, outra_org_preservada: true,
      },
    });
  });
});
