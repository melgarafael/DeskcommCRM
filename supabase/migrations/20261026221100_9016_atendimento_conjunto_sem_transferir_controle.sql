-- manifest: Preserva atendimento conjunto depois do escopo em lote da 0726, limita convite a leitura/resposta sem conceder controle e entrega entrada/saída pelo Realtime (#2542, integração #2848).
-- ---- atendimento conjunto: controle e atualização da tela (migration 9016) ----
-- A 0661 precede a 0726 na cadeia. Esta forward-fix reinstala a policy atual
-- COM participação depois dela, sem editar nenhuma migration já publicada.
do $conversations_select$ begin
  -- O ramo de PARTICIPANTE (conversa atendida em conjunto) fica, e a forma da
  -- main também: escopo resolvido em conjunto por fn_conversation_scope(), ANTES
  -- do scan. A forma antiga do PR (fn_can_view_conversation por linha) fazia o
  -- planner voltar a chamar a função por candidata — reprovado por
  -- tests/invariants/escopo-da-conversa-avaliado-uma-vez.test.ts (#2848 sobre o
  -- conserto #3090). A política abaixo é a da main (58213) + o ramo participante.
  drop policy if exists "conversations_select" on public.conversations;
  create policy "conversations_select" on public.conversations
    for select using (
      (select public.fn_is_platform_admin())
      or organization_id in (
           select s.organization_id from public.fn_conversation_scope() s where s.org_wide_read
         )
      or (
           assigned_to_user_id = auth.uid()
           and organization_id in (select s.organization_id from public.fn_conversation_scope() s)
         )
      or (
           assigned_to_user_id is null
           and organization_id in (
                select s.organization_id from public.fn_conversation_scope() s where s.sees_unassigned
              )
         )
      or exists (
           select 1
             from public.conversation_participants cp
            where cp.conversation_id = conversations.id
              and cp.organization_id = conversations.organization_id
              and cp.user_id = auth.uid()
              and cp.left_at is null
              and not exists (
                select 1 from public.contacts pc
                 where pc.id=conversations.contact_id
                   and pc.organization_id=conversations.organization_id
                   and pc.is_personal
              )
         )
    );
end $conversations_select$;

-- O convite não amplia UPDATE/DELETE. Mantém o escopo anterior de quem já
-- escrevia: owner, gestor e o modo de visibilidade configurado no banco.
-- WITH CHECK true preserva a mudança de responsável que já era permitida;
-- o USING mede a linha ANTES da escrita, não a identidade que o corpo propõe.
drop policy if exists conversation_participant_read_is_not_control_update on public.conversations;
create policy conversation_participant_read_is_not_control_update
  on public.conversations as restrictive for update to authenticated
  using (public.fn_can_view_conversation(organization_id, assigned_to_user_id))
  with check (true);
drop policy if exists conversation_participant_read_is_not_control_delete on public.conversations;
create policy conversation_participant_read_is_not_control_delete
  on public.conversations as restrictive for delete to authenticated
  using (public.fn_can_view_conversation(organization_id, assigned_to_user_id));


-- Responder não dá edição/exclusão do histórico de outra pessoa. Quem já
-- tinha escopo mantém a escrita anterior; a convidada pode editar/revogar sua
-- própria saída, como exige messages/[id], sem poder apagar linhas do histórico.
drop policy if exists message_participant_reply_is_not_history_update on public.messages;
create policy message_participant_reply_is_not_history_update
  on public.messages as restrictive for update to authenticated
  using (
    (sent_by_user_id=auth.uid() and direction='outbound' and sent_via in ('user','crm'))
    or exists (select 1 from public.conversations c
      where c.id=messages.conversation_id and c.organization_id=messages.organization_id
        and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id))
  ) with check (
    exists (select 1 from public.conversations c
      where c.id=messages.conversation_id and c.organization_id=messages.organization_id
        and (public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)
          or (messages.sent_by_user_id=auth.uid() and messages.direction='outbound'
            and messages.sent_via in ('user','crm'))))
  );
drop policy if exists message_participant_reply_is_not_history_delete on public.messages;
create policy message_participant_reply_is_not_history_delete
  on public.messages as restrictive for delete to authenticated
  using (exists (select 1 from public.conversations c
    where c.id=messages.conversation_id and c.organization_id=messages.organization_id
      and public.fn_can_view_conversation(c.organization_id,c.assigned_to_user_id)));

-- O vínculo só é escrito pelo servidor. O toque notifica quem já observa a
-- conversa, sem conceder SELECT nas participações alheias e sem trocar o dono.
create or replace function public.fn_participacao_atualiza_conversa()
returns trigger language plpgsql set search_path=public as $$
begin
  update public.conversations set updated_at=clock_timestamp()
   where id=new.conversation_id and organization_id=new.organization_id;
  return new;
end;
$$;
revoke execute on function public.fn_participacao_atualiza_conversa() from public, anon, authenticated;
grant execute on function public.fn_participacao_atualiza_conversa() to service_role;
drop trigger if exists participacao_atualiza_conversa on public.conversation_participants;
create trigger participacao_atualiza_conversa
  after insert or update on public.conversation_participants
  for each row execute function public.fn_participacao_atualiza_conversa();

-- A própria linha continua legível depois de left_at, então o removido recebe
-- a revogação. Publication pode não existir num Postgres puro do self-host.
do $participacoes_realtime$ begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime')
     and not exists (select 1 from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public' and tablename='conversation_participants') then
    alter publication supabase_realtime add table public.conversation_participants;
  end if;
end $participacoes_realtime$;

notify pgrst, 'reload schema';
