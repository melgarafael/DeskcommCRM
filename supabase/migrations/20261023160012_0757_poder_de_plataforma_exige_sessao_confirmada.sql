-- manifest: o poder de PLATAFORMA (`fn_is_platform_admin_full`, o ramo `scope = 'full'` das policies de escrita e das funções que o consultam) passa a exigir a sessão confirmada pelo código (`aal2`) de quem tem fator verificado; sem fator cadastrado nada muda (a verificação é opcional), e o papel dentro da própria organização segue como estava.
--
-- O app já cobra o código de quem age pelo poder de plataforma
-- (`mfaEmDivida` → `agindoPeloPoderDePlataforma`, `mfaEmDividaEstrita`), e a
-- 0747 fez o mesmo na anonimização; esta migration leva a mesma régua ao banco
-- inteiro. A régua é a da 0747: `aal2` do GoTrue, ou nenhum
-- fator `totp` verificado. Dispositivo confiável NÃO conta — ele vale na
-- organização onde a pessoa é admin, e lá quem autoriza é o papel
-- (`fn_role_at_least` / `fn_user_org_ids`), não esta função.
--
-- Uma definição só, e não uma guarda em cada policy: são dezenas de policies e
-- funções que perguntam `fn_is_platform_admin_full()`, e todas passam a
-- responder igual. A checagem de fator fica DENTRO do `exists`, para que só a
-- linha de um admin de plataforma pague a consulta a `auth.mfa_factors`.
-- `create or replace` preserva os grants da função (só authenticated e
-- service_role, desde o apêndice que a criou).
create or replace function public.fn_is_platform_admin_full()
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid() and pa.revoked_at is null and pa.scope = 'full'
      and (coalesce(auth.jwt()->>'aal','aal1') = 'aal2' or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = pa.user_id and f.factor_type = 'totp' and f.status = 'verified'))
  );
$$;
revoke execute on function public.fn_is_platform_admin_full() from public, anon;
grant execute on function public.fn_is_platform_admin_full() to authenticated, service_role;

-- `fn_lgpd_anonymize_contact` perguntava `fn_is_platform_admin_full()` no
-- portão de QUEM pode, e o código de sessão em seguida, com erro próprio
-- (`contact_anonymize_mfa_required`, 0747). Com a régua de sessão dentro da
-- `_full`, o admin da plataforma sem o código cairia no `forbidden` e perderia
-- a resposta que diz "falta o código". O portão passa a ler o `scope = 'full'`
-- direto — a mesma pergunta que a `_full` fazia antes desta migration —, e a
-- régua de sessão continua logo abaixo, como na 0747. Corpo igual ao da 0747
-- fora essa linha.
create or replace function public.fn_lgpd_anonymize_contact(p_organization_id uuid,p_contact_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.contacts; support jsonb; v_quando timestamptz;
begin
 support:=public.fn_support_context();
 if auth.uid() is null or not public.fn_support_write_allowed(p_organization_id)
  or not (public.fn_role_at_least(p_organization_id,'admin') or (support is null and exists(
   select 1 from public.platform_admins pa where pa.user_id=auth.uid() and pa.revoked_at is null and pa.scope='full'))) then
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
