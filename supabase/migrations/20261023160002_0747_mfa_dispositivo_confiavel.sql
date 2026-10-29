-- manifest: MFA — dispositivo confiável por 30 dias: tabela `mfa_trusted_devices` (hash do token do cookie + fator provado + sessão reconhecida, só service_role escreve) e `fn_session_mfa_proven` passa a aceitar a sessão reconhecida por dispositivo confiável dentro do prazo, e fica executável por authenticated para o app perguntar ao banco; e anonimizar contato pelo poder de plataforma (fora da organização onde a pessoa é admin) pede o código provado na sessão.
--
-- O segundo fator é cobrado em DOIS lugares: no app (`mfaEmDivida`) e no banco
-- (`fn_session_mfa_proven`, chamada por agenda, resposta, roteamento, conexões,
-- anonimização). O JWT de quem entra por dispositivo confiável continua `aal1` —
-- só o GoTrue emite `aal2`, e só depois de um código —, então a confiança mora
-- aqui, amarrada ao `session_id` do JWT, e o app pergunta a esta função.

create table if not exists public.mfa_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- O fator que o código provou. Sem FK (auth.mfa_factors é do GoTrue): a função
  -- abaixo exige que ele ainda exista, então remover o fator por QUALQUER caminho
  -- (desligar, código de recuperação, script de suporte) mata a confiança junto.
  factor_id uuid not null,
  token_hash text not null unique,
  session_id uuid,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null
);
create index if not exists mfa_trusted_devices_user_idx on public.mfa_trusted_devices (user_id);

-- Sem policy, e sem grant para quem fala com o PostgREST: quem pudesse gravar
-- aqui o próprio `session_id` dispensaria o segundo fator sozinho. Só o servidor
-- (service_role) escreve, e só depois de um código provado ou de um token de
-- dispositivo que o próprio servidor emitiu.
alter table public.mfa_trusted_devices enable row level security;
revoke all on table public.mfa_trusted_devices from anon, authenticated;

-- A mesma pergunta que as definer de agenda, resposta, roteamento etc. já fazem,
-- com uma terceira saída: a sessão foi reconhecida por um dispositivo confiável
-- ainda dentro do prazo. Exposta a `authenticated` (é `stable`, só fala da
-- própria sessão) para que o app pergunte AO BANCO em vez de manter uma segunda
-- regra que pudesse divergir desta.
create or replace function public.fn_session_mfa_proven()
returns boolean language sql stable security definer set search_path=public as $$
 select auth.uid() is not null and (coalesce(auth.jwt()->>'aal','aal1')='aal2' or not exists(
  select 1 from auth.mfa_factors where user_id=auth.uid() and factor_type='totp' and status='verified')
  or exists(select 1 from public.mfa_trusted_devices d
   join auth.mfa_factors f on f.id=d.factor_id and f.user_id=d.user_id and f.status='verified'
   where d.user_id=auth.uid() and d.session_id::text=auth.jwt()->>'session_id' and d.expires_at>now()));
$$;
revoke all on function public.fn_session_mfa_proven() from public, anon;
grant execute on function public.fn_session_mfa_proven() to authenticated;

-- Anonimizar um contato pelo PODER DE PLATAFORMA (quem não é admin da
-- organização do contato) pede o código provado NESTA sessão: a mesma régua de
-- `mfaEmDividaEstrita` no app. O dispositivo confiável vale na organização onde
-- a pessoa é admin — o dono da instalação segue usando-o na própria empresa —,
-- não nas outras. Sem fator cadastrado, nada muda (a verificação é opcional).
-- Sessão de suporte não passa por aqui: `fn_support_context` já exige `aal2`.
create or replace function public.fn_lgpd_anonymize_contact(p_organization_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.contacts; support jsonb; v_quando timestamptz;
begin
 support:=public.fn_support_context();
 if auth.uid() is null or not public.fn_support_write_allowed(p_organization_id)
  or not (public.fn_role_at_least(p_organization_id,'admin') or (public.fn_is_platform_admin_full() and support is null)) then
  raise exception 'contact_anonymize_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'contact_anonymize_mfa_required' using errcode='42501';end if;
 if not public.fn_role_at_least(p_organization_id,'admin')
  and coalesce(auth.jwt()->>'aal','aal1')<>'aal2'
  and exists(select 1 from auth.mfa_factors where user_id=auth.uid() and factor_type='totp' and status='verified') then
  raise exception 'contact_anonymize_mfa_required' using errcode='42501';
 end if;
 perform public.fn_service_lock(p_organization_id,p_contact_id);
 select * into c from public.contacts where organization_id=p_organization_id and id=p_contact_id for update;
 if not found then raise exception 'contact_not_found' using errcode='P0002';end if;
 if c.is_anonymized then return jsonb_build_object('already_anonymized',true,'anonymized_at',c.anonymized_at);end if;
 -- issue #1504 — a redação em si é da função ÚNICA. Este caminho (o botão) e o
 -- pedido formal passam por aqui; o portão acima é quem decide QUEM pode
 -- anonimizar, e nada é escrito por conta próprio neste corpo.
 perform public.fn_lgpd_cascade_redact_contact(p_organization_id,p_contact_id,null);
 select anonymized_at into v_quando
   from public.contacts where organization_id=p_organization_id and id=p_contact_id;
 return jsonb_build_object('already_anonymized',false,'anonymized_at',v_quando);
end;$$;
revoke all on function public.fn_lgpd_anonymize_contact(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.fn_lgpd_anonymize_contact(uuid,uuid) to authenticated;
