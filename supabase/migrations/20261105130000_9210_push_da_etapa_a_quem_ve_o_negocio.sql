-- manifest: **O push da etapa que avisa leva o valor e a soma do dia a quem PODE VER o negócio, e não mais só quando a organização escolhe «Todos veem tudo» (#3981).** O conteúdo do push era um só para a organização inteira, então o valor só podia entrar com `visibility_mode = 'all'` — numa carteira fechada (`own_and_unassigned`, o padrão), gerente e administrador nunca viam venda com valor, e o único remédio era abrir a visibilidade para todo atendente. O valor e a soma do dia passam a ser decididos por DESTINATÁRIO, com a régua que já existe para negócio (`fn_can_view_lead`, migrations 0036/9090): esta função avalia a MESMA regra para cada inscrito — põe o `sub` dele nos claims da transação, chama `fn_can_view_lead` e devolve as inscrições de quem vê. Nenhuma cópia da regra (papel, `visibility_mode`, dono, vínculo revogado) mora aqui, igual à `fn_push_inscricoes_que_veem_a_conversa` (0612). `ampla` diz se a pessoa vê a ORGANIZAÇÃO inteira (`fn_role_at_least(org, 'manager')`): só ela recebe a soma do dia, que é um número da organização; quem vê apenas a própria carteira recebe o valor do negócio sem a soma, e quem NÃO vê o negócio continua com a frase de antes. Visibilidade de negócio, policies de `crm_leads` e `visibility_mode` INALTERADOS. Negócio de outra organização ou inexistente: nenhuma inscrição. Só o service role executa; idempotente (`create or replace` + grants). Prova em `tests/invariants/push-da-etapa-a-quem-ve-o-negocio.test.ts`.

create or replace function public.fn_push_inscricoes_que_veem_o_negocio(
  p_org uuid,
  p_lead uuid
) returns table (id uuid, user_id uuid, endpoint text, p256dh text, auth text, ampla boolean)
language plpgsql volatile security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_dono uuid;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_claim text := current_setting('request.jwt.claim', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  select l.owner_user_id into v_dono
    from public.crm_leads l
   where l.id = p_lead and l.organization_id = p_org;
  if not found then
    return;
  end if;

  -- auth.uid()/auth.jwt() leem estas três; só `claims` carrega o inscrito.
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  for v_user in
    select distinct s.user_id from public.push_subscriptions s
     where s.organization_id = p_org
     order by s.user_id
  loop
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user)::text, true);
    if public.fn_can_view_lead(p_org, v_dono) then
      return query
        select s.id, s.user_id, s.endpoint, s.p256dh, s.auth,
               public.fn_role_at_least(p_org, 'manager')
          from public.push_subscriptions s
         where s.organization_id = p_org and s.user_id = v_user;
    end if;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim', coalesce(v_claim, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end;
$$;

revoke all on function public.fn_push_inscricoes_que_veem_o_negocio(uuid, uuid) from public;
revoke execute on function public.fn_push_inscricoes_que_veem_o_negocio(uuid, uuid) from anon, authenticated;
grant execute on function public.fn_push_inscricoes_que_veem_o_negocio(uuid, uuid) to service_role;
