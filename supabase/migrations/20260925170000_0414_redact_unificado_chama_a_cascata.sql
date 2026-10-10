-- ---- redact unificado: os DOIS caminhos de anonimizar chamam a MESMA função (migration 0414, issue #1504) ----
--
-- Acompanhamento do #1501. O #1501 consertou o sintoma (o botão da ficha passou
-- a redigir mensagens, conversa e checkpoints), mas a CAUSA continua de pé: há
-- duas redações com conjuntos diferentes, e a rota do botão não passa pela
-- função canônica.
--
--   fn_lgpd_cascade_redact_contact   pedido formal (lib/lgpd/redact-cascade.ts)
--     alcança contacts, conversations, messages, crm_lead_activities, crm_leads,
--     orders, sales, voice_calls, prospecting_candidates, agent_cases,
--     agent_case_events, demandas, agent_inbox_items, agent_case_chat_messages,
--     passagens_de_atendimento, entregas_de_aviso_de_caso, campaign_recipients,
--     campaign_suppressions — e zera contacts.consent / source_metadata / tags.
--
--   fn_lgpd_anonymize_contact        botão "Anonimizar contato" da ficha
--     reescrevia o CONTATO e mais nada: as 11 tabelas acima e os três campos do
--     contato só eram alcançados por quem abria um pedido formal. Mesmo
--     contato, mesmo direito do titular, cobertura diferente — que foi a causa
--     medida do #1501.
--
-- O QUE MUDA: o portão do botão passa a CHAMAR a cascata canônica e a parar de
-- redigir por conta própria — o `update public.contacts` que ele fazia some do
-- corpo, porque a escrita do contato é da própria cascata. Nada de tabela nova,
-- nada de dado reescrito aqui: o que a migration faz é apontar os DOIS caminhos
-- para a mesma função.
--
-- O QUE O PORTÃO CONTINUA SENDO (e é por isso que ele não some):
--
--   * autoridade — `auth.uid()`, suporte de escrita, papel `admin` da
--     organização ou platform_admin fora de sessão de suporte, e MFA comprovado,
--     tudo ANTES de qualquer escrita (a porta 42501 que
--     `tests/invariants/lgpd-agenda-lock-order.test.ts` prova);
--   * mutex — `fn_service_lock` antes do `for update`, na MESMA ordem da
--     0229, para não inverter a espera com o resto do schema;
--   * contrato de retorno — `{already_anonymized, anonymized_at}` com a data
--     ORIGINAL na retomada, inclusive o objeto de IGUALDADE EXATA que o teste
--     da porta legada cobra na segunda chamada.
--
-- A cascata recebe `p_request_id = null`: no caminho do botão não há pedido de
-- titular, e a fila de mídia (idempotente por `(bucket, object_path)`) e a linha
-- de auditoria já aceitam nulo — é o mesmo formato com que a migration 0391
-- enfileira a mídia do gatilho.
--
-- O RÓTULO passa a ser o da própria cascata (`Cliente Anonimizado #<8>`), que é
-- o que o pedido formal já gravava: um rótulo só para a mesma operação. A cópia
-- do diálogo (`components/contacts/AnonymizeDialog.tsx`) acompanha.
--
-- O apêndice do `supabase/baseline.sql` leva o MESMO corpo antes da varredura
-- de anon — o self-host aplica o baseline, e `apendice-do-baseline-nao-diverge-
-- da-cadeia` cobra que os dois sejam o mesmo código.

create or replace function public.fn_lgpd_anonymize_contact(p_organization_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.contacts; support jsonb; v_quando timestamptz;
begin
 support:=public.fn_support_context();
 if auth.uid() is null or not public.fn_support_write_allowed(p_organization_id)
  or not (public.fn_role_at_least(p_organization_id,'admin') or (public.fn_is_platform_admin() and support is null)) then
  raise exception 'contact_anonymize_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'contact_anonymize_mfa_required' using errcode='42501';end if;
 perform public.fn_service_lock(p_organization_id,p_contact_id);
 select * into c from public.contacts where organization_id=p_organization_id and id=p_contact_id for update;
 if not found then raise exception 'contact_not_found' using errcode='P0002';end if;
 if c.is_anonymized then return jsonb_build_object('already_anonymized',true,'anonymized_at',c.anonymized_at);end if;
 -- issue #1504 — a redação em si é da função ÚNICA. Este caminho (o botão) e o
 -- pedido formal passam por aqui; o portão acima é quem decide QUEM pode
 -- anonimizar, e nada é escrito por conta própria neste corpo.
 perform public.fn_lgpd_cascade_redact_contact(p_organization_id,p_contact_id,null);
 select anonymized_at into v_quando
   from public.contacts where organization_id=p_organization_id and id=p_contact_id;
 return jsonb_build_object('already_anonymized',false,'anonymized_at',v_quando);
end;$$;
revoke all on function public.fn_lgpd_anonymize_contact(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.fn_lgpd_anonymize_contact(uuid,uuid) to authenticated;
