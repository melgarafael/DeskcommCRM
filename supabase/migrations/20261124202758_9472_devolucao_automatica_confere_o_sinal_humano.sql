-- manifest: **A devolução automática ao agente solta o dono só se a conversa ainda estiver parada.** O cron `handoff-devolucao` varre as conversas e, segundos depois, solta o dono de cada vencida; uma resposta do atendente nesse intervalo não era vista e a conversa voltava à IA logo depois de a pessoa responder. `fn_conversation_release_if_idle` trava a linha, confere o dono lido na varredura e que nenhum sinal humano (`last_handoff_at`, `assigned_at`, `last_outbound_at`) é posterior ao corte, e só então chama `fn_conversation_assign` (release) na MESMA transação. Só `service_role`. Baseline INSTALL/UPDATE idempotente.
-- 9472 — a devolução automática confere o último sinal humano sob o lock da linha.
--
-- O cron lê a conversa, decide que ela venceu o prazo e só depois escreve. A
-- precondição de dono (`p_expected_assignee`) fecha a troca de dono no meio,
-- mas não a resposta do MESMO dono: ela só move `last_outbound_at`. Conferir isso
-- no app seria outra leitura antes da escrita, com a mesma janela.
--
-- Por que um invólucro e não um parâmetro novo em `fn_conversation_assign`:
-- mudar a assinatura dela exigiria derrubar a de 8 argumentos e recopiar o corpo
-- inteiro (9361), na porta única de toda atribuição. Aqui o lock é tomado antes,
-- com a mesma força (`for no key update`), e a chamada interna o reaproveita.
--
-- Devolve `true` quando soltou o dono e `false` quando a conversa mudou (dono
-- diferente, sinal humano depois do corte, ou nenhuma linha).

create or replace function public.fn_conversation_release_if_idle(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_expected_assignee uuid,
  p_sem_sinal_humano_desde timestamptz
) returns boolean
language plpgsql
set search_path = public
as $$
begin
  perform 1
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
     and assigned_to_user_id is not distinct from p_expected_assignee
     and coalesce(last_handoff_at, '-infinity') <= p_sem_sinal_humano_desde
     and coalesce(assigned_at, '-infinity') <= p_sem_sinal_humano_desde
     and coalesce(last_outbound_at, '-infinity') <= p_sem_sinal_humano_desde
   for no key update;
  if not found then
    return false;
  end if;

  return exists (
    select 1
      from public.fn_conversation_assign(
        p_organization_id, p_conversation_id, null, 'release', p_expected_assignee, true)
  );
end;
$$;

revoke execute on function public.fn_conversation_release_if_idle(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fn_conversation_release_if_idle(uuid, uuid, uuid, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
