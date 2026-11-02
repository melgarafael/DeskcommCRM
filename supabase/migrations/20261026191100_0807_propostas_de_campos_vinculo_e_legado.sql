-- manifest: lead_field_proposals: WITH CHECK exige negócio visível da mesma organização; motivos legados de contatos já anonimizados saem pelos vínculos direto e crm_lead_links, sem repetir a anonimização
--
-- 0807 — duas correções forward para clones que aplicaram a 0772 (#3476).
-- A 0772 e a 0797 permanecem intactas: podem ter sido aplicadas no fork.
--
-- Provado no Postgres 17: INSERT sem RETURNING passava com orgA + leadB,
-- porque a FK simples só conhece o id e o WITH CHECK omitia o vínculo que o
-- USING já cobra. A MESMA régua passa a valer para a linha nova também.
drop policy if exists tenant_isolation_lead_field_proposals_write on public.lead_field_proposals;
create policy tenant_isolation_lead_field_proposals_write on public.lead_field_proposals
  for all to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = lead_field_proposals.lead_id
           and l.organization_id = lead_field_proposals.organization_id
      )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and exists (
        select 1 from public.crm_leads l
         where l.id = lead_field_proposals.lead_id
           and l.organization_id = lead_field_proposals.organization_id
      )
  );

-- Trocar a função na 0797 protege as próximas anonimizações, mas não visita
-- quem a 0772 já marcou como anonimizado: o retry retorna antes da cascata.
-- Cura só o motivo que ficou, com todos os vínculos escopados por organização.
-- Não reescreve a decisão, o rótulo nem a data original do direito; contato
-- vivo e proposta já limpa ficam intactos, inclusive na reaplicação.
update public.lead_field_proposals p
   set motivo_recusa = null,
       updated_at = now()
  from public.crm_leads l
 where p.organization_id = l.organization_id
   and p.lead_id = l.id
   and p.motivo_recusa is not null
   and (
     exists (
       select 1 from public.contacts c
        where c.organization_id = p.organization_id
          and c.id = l.contact_id
          and c.is_anonymized
     )
     or exists (
       select 1 from public.crm_lead_links vinculo
       join public.contacts c
         on c.id = vinculo.target_id
        and c.organization_id = vinculo.organization_id
        and c.is_anonymized
        where vinculo.organization_id = p.organization_id
          and vinculo.lead_id = p.lead_id
          and vinculo.target_kind = 'contact'
     )
   );
