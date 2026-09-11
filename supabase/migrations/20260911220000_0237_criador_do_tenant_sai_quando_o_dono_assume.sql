-- 0237 — quem cria um tenant PARA OUTRA PESSOA sai dele quando essa pessoa assume.
--
-- ─── O defeito, medido ──────────────────────────────────────────────────────
--
-- `fn_create_tenant_with_owner` inscreve o criador como `admin` aceito na mesma
-- transação que cria a organização. Faz sentido enquanto alguém precisa entrar e
-- configurar antes de o dono aceitar o convite — mas **nada nunca o tira de lá**:
--
--   • a aba "Equipe" do painel de plataforma é `disabled: true` ("em breve");
--   • `/api/v1/team/[user_id]/revoke` recusa auto-revogação ("Cannot revoke self");
--   • a jornada de convite não conhece o criador.
--
-- Resultado numa instalação real de revenda: o cliente abre Equipe › Membros e
-- encontra o **e-mail pessoal do revendedor** listado como colega, ocupando
-- cadeira, oferecido como responsável em agenda que não é dele — e podendo ser
-- revogado por ele. O criador, por sua vez, não tem porta de saída nenhuma.
--
-- Não é falha de isolamento: a listagem filtra `organization_id` corretamente, e
-- quem instalou o servidor já enxerga tudo por impersonação. É desenho pela
-- metade — o produto coloca alguém lá dentro e não construiu a saída.
--
-- ─── Por que a saída é AQUI, e não um botão ────────────────────────────────
--
-- A entrega do tenant tem um instante observável: **o dono aceita o convite**.
-- Antes dele o tenant precisa de alguém dentro (senão nasce inacessível); depois
-- dele o criador não tem mais o que fazer ali. Amarrar a saída a esse instante
-- não depende de ninguém lembrar de nada, e nunca deixa a organização vazia.
--
-- ─── O discriminador, e por que não há coluna nova ─────────────────────────
--
-- `invited_at` já separa as duas origens de um vínculo, sem schema novo:
--
--   • criado por `fn_create_tenant_with_owner`  → `invited_at` **nulo**
--   • criado por `fn_accept_team_invite`        → `invited_at` preenchido
--
-- Então "entrou pela criação, não por convite" é `invited_at is null`, e um
-- criador que mais tarde aceitar um convite de verdade deixa de casar com a
-- regra — que é exatamente o desejado.
--
-- ─── As quatro condições, e o que cada uma impede ──────────────────────────
--
--   uo.user_id = o.created_by   → só o criador sai; ninguém mais é tocado
--   uo.user_id <> p_user        → quem cria o PRÓPRIO tenant continua nele
--   uo.invited_at is null       → vínculo de criação, nunca um convite aceito
--   p_role = 'admin'            → é o DONO assumindo, não um colega qualquer
--                                 entrando depois (o convite do dono nasce
--                                 `admin` em `/api/v1/admin/tenants`)
--   platform_admins ativo       → a regra vale para o dono do servidor, não
--                                 para um admin comum que criou algo
--
-- O `delete` cascateia `channel_routing_responsibles` (FK `on delete cascade`),
-- que é o certo: quem sai da organização para de ser responsável por
-- roteamento. `attendant_availability` não tem FK para o vínculo e ficaria
-- órfã — some junto, no mesmo passo: é configuração operacional tenant-scoped
-- de alguém que acabou de deixar o tenant.

create or replace function public.fn_accept_team_invite(
  p_user uuid, p_org uuid, p_role text, p_invited_by uuid,
  p_issued_at timestamptz, p_invited_at timestamptz,
  p_interface_settings jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.user_organizations%rowtype;
begin
  if p_role not in ('viewer','agent','manager','admin') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_org::text, 0));
  if not exists(select 1 from public.organizations where id = p_org and status = 'active') then
    raise exception 'organization_unavailable' using errcode = '42501';
  end if;
  select * into m from public.user_organizations
    where organization_id = p_org and user_id = p_user for update;
  if found and m.revoked_at is null and m.accepted_at is not null then
    return jsonb_build_object('id', m.id, 'changed', false);
  end if;
  if found and m.revoked_at is not null and (p_issued_at is null or p_issued_at <= m.revoked_at) then
    raise exception 'invite_revoked' using errcode = '42501';
  end if;
  if m.id is not null then
    update public.user_organizations set role = p_role, revoked_at = null, interface_settings = p_interface_settings,
      invited_by = coalesce(p_invited_by, invited_by), invited_at = p_invited_at,
      accepted_at = now(), updated_at = now()
      where organization_id = p_org and id = m.id returning * into m;
  else
    insert into public.user_organizations(organization_id, user_id, role, invited_by, invited_at, accepted_at, interface_settings)
      values (p_org, p_user, p_role, p_invited_by, p_invited_at, now(), p_interface_settings) returning * into m;
  end if;

  -- O DONO ASSUMIU: o criador provisório sai. Depois do vínculo do dono estar
  -- gravado, nunca antes — a organização não pode ficar sem ninguém no meio.
  if p_role = 'admin' then
    delete from public.attendant_availability av
      using public.organizations o
      where o.id = p_org
        and av.organization_id = p_org
        and av.user_id = o.created_by
        and av.user_id <> p_user
        and exists (select 1 from public.user_organizations uo
                     where uo.organization_id = p_org and uo.user_id = o.created_by
                       and uo.invited_at is null)
        and exists (select 1 from public.platform_admins pa
                     where pa.user_id = o.created_by and pa.revoked_at is null);

    delete from public.user_organizations uo
      using public.organizations o
      where o.id = p_org
        and uo.organization_id = p_org
        and uo.user_id = o.created_by
        and uo.user_id <> p_user
        and uo.invited_at is null
        and exists (select 1 from public.platform_admins pa
                     where pa.user_id = o.created_by and pa.revoked_at is null);
  end if;

  return jsonb_build_object('id', m.id, 'changed', true);
end $$;

revoke all on function public.fn_accept_team_invite(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.fn_accept_team_invite(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb) to service_role;

-- ─── O atalho de 6 argumentos é REEMITIDO, e isto não é enfeite ───────────
--
-- `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts` compara, por
-- NOME de função, a última definição da cadeia de migrations com a última do
-- apêndice do baseline. No baseline a última é este atalho; se a migration
-- terminasse na de 7 argumentos, os dois lados divergiriam — e a cerca reprova,
-- com razão: quem aplica a cadeia e quem aplica o baseline receberiam a mesma
-- função em ordens diferentes.
--
-- Reemitir é idempotente e barato: o corpo é idêntico ao que já está lá.

create or replace function public.fn_accept_team_invite(
 p_user uuid, p_org uuid, p_role text, p_invited_by uuid,
 p_issued_at timestamptz, p_invited_at timestamptz
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
 select public.fn_accept_team_invite(p_user,p_org,p_role,p_invited_by,p_issued_at,p_invited_at,'{"preset":"completa"}'::jsonb);
$$;
revoke all on function public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz) to service_role;

-- ─── Os que JÁ estão presos ────────────────────────────────────────────────
--
-- A regra acima só alcança aceites futuros. Numa instalação onde o dono já
-- aceitou, o criador continua lá — e é justamente o caso que motivou esta
-- migration. O expurgo abaixo aplica exatamente as mesmas condições, uma vez,
-- exigindo além delas que o dono JÁ tenha assumido (existe outro admin aceito e
-- não revogado). Sem essa exigência, um tenant cujo convite nunca foi aceito
-- ficaria sem ninguém dentro.
--
-- Genérico por construção: nenhum id de tenant, nenhum e-mail. Um clone sem
-- nenhum caso apaga zero linhas.

delete from public.attendant_availability av
  using public.organizations o
  where av.organization_id = o.id
    and av.user_id = o.created_by
    and exists (select 1 from public.user_organizations uo
                 where uo.organization_id = o.id and uo.user_id = o.created_by
                   and uo.invited_at is null)
    and exists (select 1 from public.platform_admins pa
                 where pa.user_id = o.created_by and pa.revoked_at is null)
    and exists (select 1 from public.user_organizations dono
                 where dono.organization_id = o.id and dono.user_id <> o.created_by
                   and dono.role = 'admin' and dono.accepted_at is not null
                   and dono.revoked_at is null);

delete from public.user_organizations uo
  using public.organizations o
  where uo.organization_id = o.id
    and uo.user_id = o.created_by
    and uo.invited_at is null
    and exists (select 1 from public.platform_admins pa
                 where pa.user_id = o.created_by and pa.revoked_at is null)
    and exists (select 1 from public.user_organizations dono
                 where dono.organization_id = o.id and dono.user_id <> o.created_by
                   and dono.role = 'admin' and dono.accepted_at is not null
                   and dono.revoked_at is null);

notify pgrst, 'reload schema';
