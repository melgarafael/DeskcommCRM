-- A lista/contagem do Inbox excedia 8 s após importar 3.239 conversas.
-- Mantém a regra canônica e RLS invoker. Evita resolver duas vezes o contato,
-- e não o consulta quando dono, encerramento ou silêncio já decidem o comando.
create or replace function public.comando_da_conversa(c public.conversations)
returns text
language plpgsql
stable
security invoker
set search_path = public
as $comando$
declare
  v_force_human boolean;
  v_is_blocked boolean;
begin
  if c.assigned_to_user_id is not null
    or c.status in ('closed', 'archived', 'resolved')
    or c.bot_silenced_until > now() then
    return public.fn_comando_da_conversa(
      c.status, c.assigned_to_user_id, c.bot_silenced_until, false, false, now()
    );
  end if;

  select ct.force_human, ct.is_blocked into v_force_human, v_is_blocked
    from public.contacts ct where ct.id = c.contact_id;
  return public.fn_comando_da_conversa(
    c.status, c.assigned_to_user_id, c.bot_silenced_until,
    coalesce(v_force_human, false), coalesce(v_is_blocked, false), now()
  );
end;
$comando$;

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;
