-- ---- o roteiro de atendimento encerra quando um humano assume, no opt-out e no prazo (migration 0397, #1130) ----
--
-- PR 2 do port dos fluxos de atendimento (de @vgamkt). Achados 9 e 5 da prova
-- prática: o roteiro continuava 'coletando' depois de um humano assumir a
-- conversa, e nunca expirava.
--
-- 1. HUMANO ASSUMIU e OPT-OUT, num lugar só. `contacts.force_human` é gravado
--    por vários caminhos (a passagem do motor, a ferramenta de handoff, o
--    orquestrador, o teto de orçamento) e `contacts.is_blocked` pela ingestão
--    do canal e pela confirmação do opt-out. Remendar cada escritor é a classe
--    que o autor pagou cinco vezes. Um gatilho na VIRADA false→true de qualquer
--    das duas colunas encerra o roteiro vivo do contato ('cancelled'), com o
--    evento `roteiro_cancelado` na trilha — o mesmo desenho do gatilho da
--    anonimização (0394). Encerrar, e não pausar: com uma pessoa na conversa,
--    retomar depois as perguntas de antes é falar sobre o que ela já tratou.
--    A pausa CURTA por resposta manual pelo celular (`bot_silenced_until`, com
--    prazo) não encerra: o roteiro só não roda enquanto a IA está calada, e
--    volta com ela; se a pessoa sumir, o prazo abaixo encerra.
--
-- 2. PRAZO. `fn_encerrar_roteiros_vencidos` encerra o 'coletando' sem
--    atividade há mais de `settings.expira_em_horas` do grafo (padrão 72 h),
--    contando da última mensagem que o roteiro leu (ou do início). Roda no
--    relógio do follow-up, em lotes, com o evento `roteiro_expirado`. Só o
--    service_role executa.
--
-- Idempotente, sem BEGIN/COMMIT. Nenhum dado existente é reescrito.

create or replace function public.fn_contato_encerra_roteiro_com_humano_ou_opt_out()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_motivo text;
begin
  if new.is_blocked = true and coalesce(old.is_blocked, false) = false then
    v_motivo := 'opt_out';
  elsif new.force_human = true and coalesce(old.force_human, false) = false then
    v_motivo := 'humano_assumiu';
  else
    return new;
  end if;

  with encerrados as (
    update public.followup_enrollments
       set status = 'cancelled',
           cancel_reason = case v_motivo when 'opt_out' then 'Contato pediu para parar (opt-out)'
                                         else 'Humano assumiu o atendimento' end,
           completed_at = now(),
           updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.id
       and status = 'coletando'
    returning id, organization_id, current_node_id
  )
  insert into public.followup_enrollment_events
    (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
  select organization_id, id, current_node_id, 'roteiro_cancelado',
         jsonb_build_object('motivo', v_motivo), 'roteiro_cancelado:' || v_motivo
    from encerrados
  on conflict do nothing;
  return new;
end
$$;

revoke all on function public.fn_contato_encerra_roteiro_com_humano_ou_opt_out() from public;
revoke execute on function public.fn_contato_encerra_roteiro_com_humano_ou_opt_out() from anon;
revoke execute on function public.fn_contato_encerra_roteiro_com_humano_ou_opt_out() from authenticated;

drop trigger if exists trg_contato_encerra_roteiro_com_humano_ou_opt_out on public.contacts;
create trigger trg_contato_encerra_roteiro_com_humano_ou_opt_out
  after update of force_human, is_blocked on public.contacts
  for each row
  when ((new.force_human = true and coalesce(old.force_human, false) = false)
     or (new.is_blocked = true and coalesce(old.is_blocked, false) = false))
  execute function public.fn_contato_encerra_roteiro_com_humano_ou_opt_out();

create or replace function public.fn_encerrar_roteiros_vencidos(p_limite int default 200)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_encerrados int;
begin
  with vencidos as (
    select e.id
      from public.followup_enrollments e
      join public.followup_flow_versions v on v.id = e.version_id and v.organization_id = e.organization_id
     where e.status = 'coletando'
       and greatest(
             e.started_at,
             coalesce((select max(ev.created_at) from public.followup_enrollment_events ev
                        where ev.enrollment_id = e.id and ev.organization_id = e.organization_id
                          and ev.event_type = 'roteiro_mensagem'), e.started_at)
           ) < now() - make_interval(hours => case
             when (v.graph->'settings'->>'expira_em_horas') ~ '^[0-9]{1,4}$'
               then greatest(1, (v.graph->'settings'->>'expira_em_horas')::int)
             else 72 end)
     order by e.started_at
     limit greatest(1, least(coalesce(p_limite, 200), 1000))
     for update of e skip locked
  ),
  encerrados as (
    update public.followup_enrollments e
       set status = 'cancelled',
           cancel_reason = 'Roteiro expirou sem resposta',
           completed_at = now(),
           updated_at = now()
      from vencidos
     where e.id = vencidos.id and e.status = 'coletando'
    returning e.id, e.organization_id, e.current_node_id
  ),
  eventos as (
    insert into public.followup_enrollment_events
      (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key)
    select organization_id, id, current_node_id, 'roteiro_expirado', '{}'::jsonb, 'roteiro_expirado'
      from encerrados
    on conflict do nothing
    returning 1
  )
  select count(*)::int into v_encerrados from encerrados;
  return v_encerrados;
end
$$;

revoke all on function public.fn_encerrar_roteiros_vencidos(int) from public;
revoke execute on function public.fn_encerrar_roteiros_vencidos(int) from anon;
revoke execute on function public.fn_encerrar_roteiros_vencidos(int) from authenticated;
grant execute on function public.fn_encerrar_roteiros_vencidos(int) to service_role;

notify pgrst, 'reload schema';
