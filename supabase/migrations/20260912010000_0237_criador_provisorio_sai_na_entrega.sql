-- 0237 — quem cria um tenant PARA OUTRA PESSOA sai dele quando essa pessoa assume.
--
-- ⚠️ ESTA É A SEGUNDA TENTATIVA. A primeira foi publicada, apagou demais e foi
-- revertida — leia o parágrafo "O que a primeira versão errou" antes de mexer
-- aqui, porque o erro é sedutor e volta fácil.
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
--
-- `fn_create_tenant_with_owner` inscreve o criador como `admin` aceito na mesma
-- transação que cria a organização. Isso é NECESSÁRIO: sem ninguém dentro ela
-- nasceria inacessível, e nem daria para configurá-la antes de entregar.
--
-- O que falta é a saída. Não existe nenhuma: a aba "Equipe" do painel de
-- plataforma é `disabled: true`, `/api/v1/team/[user_id]/revoke` recusa
-- auto-revogação, e a jornada de convite não conhece o criador.
--
-- Numa revenda o cliente abre Equipe › Membros e encontra o e-mail PESSOAL de
-- quem instalou listado como colega — ocupando cadeira, oferecido como
-- responsável em agenda que não é dele, e podendo removê-lo.
--
-- ─── O que a primeira versão errou, e por quê ──────────────────────────────
--
-- Ela tentou DEDUZIR, olhando o banco, algo que o banco não guarda: para quem
-- cada organização foi criada. O substituto inventado foi *"se existe outro
-- admin aceito, então a entrega aconteceu"*.
--
-- É falso numa organização que a pessoa abriu PARA SI e depois deu `admin` a um
-- sócio. Em produção, o dono do servidor perdeu o vínculo com a própria empresa
-- e a tela respondeu "Você não tem nenhuma organização ativa".
--
-- A causa era de INFORMAÇÃO, não de predicado. Nenhuma condição escrita depois
-- separa os dois casos — o dado não está lá para ser lido.
--
-- ─── O conserto: gravar na origem ──────────────────────────────────────────
--
-- `fn_create_tenant_with_owner` JÁ SABE, no instante da criação, se o dono é
-- outra pessoa: ela compara `owner_email` com o e-mail de quem cria, inline,
-- para escolher `interface_settings`. Sabia e não anotava.
--
-- Agora anota, em `user_organizations.provisional_until_handover`. O vínculo do
-- criador nasce marcado como provisório **apenas quando o tenant é de outra
-- pessoa**; quando alguém cria o próprio, a coluna fica `false` e nada nesta
-- migration volta a tocá-lo nunca.
--
-- Isso fecha o caso que quebrou: organização criada por `/signup`
-- (`lib/auth/provision.ts`) nunca passa por aqui e nasce com o default `false`.
--
-- ─── E NÃO HÁ EXPURGO RETROATIVO. De propósito. ────────────────────────────
--
-- Vínculos que já existem não têm a marca, e NADA pode inferi-la depois — é
-- exatamente a dedução que custou o acesso de alguém. Instalações com um
-- criador preso num tenant entregue antes desta versão resolvem à mão, com uma
-- pessoa olhando cada caso. Um apagamento automático "esperto" aqui é o mesmo
-- erro com outra roupa.

alter table public.user_organizations
  add column if not exists provisional_until_handover boolean not null default false;

comment on column public.user_organizations.provisional_until_handover is
  'Este vínculo existe só para a organização não nascer vazia, e sai quando o '
  'dono assumir. Gravado APENAS por fn_create_tenant_with_owner, e apenas '
  'quando o tenant foi criado para OUTRA pessoa (owner_email <> e-mail de quem '
  'cria). Nunca deduzir este valor depois: a ausência dele foi o que fez a '
  'primeira versão desta regra expulsar alguém da própria empresa.';

-- ─── Criação: marca o vínculo do criador quando o tenant é de outra pessoa ──

create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
  dono_e_outra_pessoa boolean;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor
    and revoked_at is null and scope = 'full') then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0));
  select * into prior from public.idempotency_keys
    where key = p_key::text and endpoint = '/api/v1/admin/tenants:' || p_actor::text
      and expires_at > now() and tenant_creation_trusted;
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text
      or not exists (select 1 from public.organizations where id = prior.organization_id and created_by = p_actor) then
      raise exception 'idempotency_provenance_invalid' using errcode = '22023';
    end if;
    return prior.response_body || jsonb_build_object('created', false);
  end if;

  -- A MESMA comparação que já decidia `interface_settings`, agora com nome e
  -- guardada. Era ela que sabia a resposta e não a anotava em lugar nenhum.
  dono_e_outra_pessoa := lower(p_request->>'owner_email') is distinct from
    (select lower(email) from auth.users where id = p_actor);

  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active', jsonb_build_object('plan', p_request->>'plan'), p_actor)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at, interface_settings, provisional_until_handover)
    values (org.id, p_actor, 'admin', now(),
      case when dono_e_outra_pessoa
        then '{"preset":"completa"}'::jsonb
        else coalesce(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb) end,
      dono_e_outra_pessoa);
  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result, true);
  return result || jsonb_build_object('created', true);
end $$;

revoke all on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) to service_role;

-- ─── Entrega: o dono assume, e o provisório sai ────────────────────────────
--
-- O `delete` roda DEPOIS de o vínculo do dono estar gravado, nunca antes — a
-- organização não pode ficar sem ninguém no meio do caminho.
--
-- A condição é uma só e é o dado, não um sintoma: `provisional_until_handover`.
-- `user_id <> p_user` fica como cinto de segurança para o caso de o próprio
-- criador vir a aceitar um convite para o tenant que ele criou.
--
-- O `delete` cascateia `channel_routing_responsibles` (FK `on delete cascade`),
-- que é o certo. `attendant_availability` não tem FK para o vínculo e ficaria
-- órfã — sai no mesmo passo.

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

  -- O DONO ASSUMIU. Só o vínculo MARCADO como provisório sai, e só ele.
  if p_role = 'admin' then
    delete from public.attendant_availability av
      where av.organization_id = p_org
        and av.user_id <> p_user
        and exists (select 1 from public.user_organizations uo
                     where uo.organization_id = p_org and uo.user_id = av.user_id
                       and uo.provisional_until_handover);

    delete from public.user_organizations uo
      where uo.organization_id = p_org
        and uo.provisional_until_handover
        and uo.user_id <> p_user;
  end if;

  return jsonb_build_object('id', m.id, 'changed', true);
end $$;

revoke all on function public.fn_accept_team_invite(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.fn_accept_team_invite(uuid, uuid, text, uuid, timestamptz, timestamptz, jsonb) to service_role;

-- O atalho de 6 argumentos é REEMITIDO porque
-- `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts` compara, por
-- NOME de função, a última definição da cadeia com a última do apêndice — e no
-- baseline a última é este atalho. Terminar na de 7 argumentos faz os dois
-- lados divergirem. Reemitir é idempotente: o corpo é idêntico ao que já está lá.
create or replace function public.fn_accept_team_invite(
 p_user uuid, p_org uuid, p_role text, p_invited_by uuid,
 p_issued_at timestamptz, p_invited_at timestamptz
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
 select public.fn_accept_team_invite(p_user,p_org,p_role,p_invited_by,p_issued_at,p_invited_at,'{"preset":"completa"}'::jsonb);
$$;
revoke all on function public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_accept_team_invite(uuid,uuid,text,uuid,timestamptz,timestamptz) to service_role;

notify pgrst, 'reload schema';
