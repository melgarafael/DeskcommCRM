-- manifest: **O desfecho do negócio alcança a origem: `lead.won` e `lead.lost` entram na tabela de pares `(tipo, entidade) → contato` (#5077).** `fn_service_event_contact` conhecia `lead.created`, `lead.stage_changed`, `lead.tag_added`, `lead.date_field_due` e `lead.stage_stale`, mas não os dois tipos que o gatilho de `crm_leads` emite quando o negócio vira ganho ou perdido: com `suportado=false`, `fn_service_event_origin` levantava `service_event_origin_unsupported` (`PT409`), a ação `start_message_flow` virava `internal_error` no recibo e a execução terminava `partial` — o card criado por `create_or_move_lead` ficava, e nenhuma inscrição de follow-up nascia. O ramo novo resolve o contato por `crm_leads.contact_id`, na mesma forma dos outros tipos, e aceita `entity_kind='crm_lead'` (o que a issue nomeia) e `entity_kind='lead'` (o valor que `fn_log_event` deriva do prefixo do tipo e o que a linha de `event_log` realmente carrega) — sem o segundo, a recusa continuaria no caminho real. `lead.reopened` e o que a família de gatilho emitir além de won/lost ficam fora de escopo. Nenhum par existente muda e o `else` segue devolvendo `suportado=false`. Idempotente; apêndice espelhado no `baseline.sql` (corpo editado no lugar); `MANIFEST.md` é histórico e não recebe linha.
--
-- 9470 — o serviço conhece negócio ganho e perdido (#5077).
--
-- ─── O defeito ─────────────────────────────────────────────────────────────
--
-- A issue mediu uma regra com gatilho "Negócio ganho" + `create_or_move_lead`
-- + `start_message_flow`: o card nasce e a execução termina `partial`, com a
-- ação de mensagem em `internal_error`. O recibo esconde a causa; ela é
-- `fn_service_event_origin`, que chama a tabela de pares
-- (`fn_service_event_contact`) e, quando ela devolve `suportado=false`,
-- levanta `service_event_origin_unsupported` (`PT409`). O `PT409` vira
-- `StaleServiceBoundaryError` na aplicação e nenhuma inscrição é criada — a
-- mesma família de #2326 (aniversário/compromisso) e #3286 (data do funil).
--
-- ─── Por que DOIS rótulos de entidade ──────────────────────────────────────
--
-- A issue sugere `entity_kind='crm_lead'`, e é o rótulo que os tipos
-- `lead.created`, `lead.stage_changed`, `lead.tag_added`, `lead.date_field_due`
-- e `lead.stage_stale` carregam. Mas o desfecho não passa por eles: quem o
-- emite é `fn_emit_event_on_lead_change`, via `emit_event('lead.won','lead',…)`
-- (e `'lead.lost'`), e o `fn_log_event` deriva a entidade do PREFIXO do tipo
-- (`split_part(p_event_type,'.',1)`), então a linha de `event_log` nasce com
-- `entity_kind='lead'`. Aceitar só `crm_lead` faria a consulta de prova passar
-- e deixaria a recusa de pé no caminho real. Os dois rótulos entram apenas no
-- ramo de won/lost: os pares que já funcionavam seguem com o mesmo `crm_lead`.
--
-- ─── O que NÃO muda ────────────────────────────────────────────────────────
--
-- `lead.reopened` (emitido pelo mesmo gatilho quando o card volta a `open`) e
-- qualquer outro tipo da família ficam de fora: a issue pede won/lost, e abrir
-- o resto seria ampliar sem medir o efeito. O `else return query select
-- null::uuid,false` continua sendo a recusa declarada para tudo que não foi
-- mapeado. `revoke`/`grant` da função seguem idênticos.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `create or replace function` de assinatura inalterada: rodar duas vezes não
-- erra e o corpo final é o mesmo. O bloco do `baseline.sql` é editado NO LUGAR
-- (a última definição, a da 9206), de onde a cadeia e o apêndice derivam.

create or replace function public.fn_service_event_contact(p_org uuid,p_event_type text,p_entity_kind text,p_entity_id uuid)
returns table(contact_id uuid,suportado boolean) language plpgsql stable security definer set search_path=public as $$
begin
 if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added','lead.date_field_due','lead.stage_stale') and p_entity_kind='crm_lead' then
   return query select (select l.contact_id from public.crm_leads l where l.organization_id=p_org and l.id=p_entity_id),true;
 elsif p_event_type in ('lead.won','lead.lost') and p_entity_kind in ('crm_lead','lead') then
   return query select (select l.contact_id from public.crm_leads l where l.organization_id=p_org and l.id=p_entity_id),true;
 elsif p_event_type in ('contact.tag_added','contact.birthday','contact.phone_added') and p_entity_kind='contact' then
   return query select (select c.id from public.contacts c where c.organization_id=p_org and c.id=p_entity_id),true;
 elsif p_event_type in ('appointment.created','appointment.confirmed','appointment.rescheduled','appointment.cancelled','appointment.completed','appointment.no_show') and p_entity_kind='calendar_appointment' then
   return query select (select a.contact_id from public.calendar_appointments a where a.organization_id=p_org and a.id=p_entity_id),true;
 else
   return query select null::uuid,false;
 end if;
end $$;
revoke all on function public.fn_service_event_contact(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_contact(uuid,text,text,uuid) to service_role;
