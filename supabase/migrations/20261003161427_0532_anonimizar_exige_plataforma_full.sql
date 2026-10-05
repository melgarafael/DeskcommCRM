-- manifest: **Anonimizar contato (irreversível) deixa de aceitar platform admin `support_readonly` fora de sessão de suporte — mesma classe do #2000/#2078/#2115, agora na superfície RPC.** `fn_lgpd_anonymize_contact` é `security definer` e concedida a `authenticated`; o portão aceitava `(fn_is_platform_admin() and support is null)`, e `fn_is_platform_admin()` ignora o scope do JWT. Um platform admin só-de-leitura, sem sessão de suporte, anonimizava contato de qualquer organização pela chamada direta ao PostgREST. A rota da tela já recusava: desde 9c0cf9114 o `requireRole` só abre o atalho de plataforma para `scope=full`, então o buraco era só a chamada direta. Varredura das 269 funções do baseline: das 6 definer que citam a função pura, 2 são predicados de leitura (`fn_can_view_*`), 2 leem agenda, 1 é `service_role`-only (`fn_honorarios_provisionar`); esta é a única alcançável que escreve. Conserto: `fn_is_platform_admin_full()`. Gate: `tests/invariants/lgpd-agenda-lock-order.test.ts` — o caso que faltava (scope `support_readonly` sem sessão de suporte) e o controle positivo `full`.

-- 0532: o portão do botão de anonimizar exige platform admin `full`
-- (mesma classe do #2000, #2078 e #2115 — agora na superfície RPC).
--
-- `fn_lgpd_anonymize_contact` é `security definer`, concedida a `authenticated`,
-- e a rota `app/api/v1/lgpd/anonymize/route.ts` chama por RPC com a sessão do
-- usuário. O portão era:
--
--   or not (public.fn_role_at_least(p_organization_id,'admin')
--           or (public.fn_is_platform_admin() and support is null)) then
--
-- `fn_is_platform_admin()` ignora o `scope` do JWT (`platform_admins.scope`).
-- Um platform admin `support_readonly` — o modo de observação —, sem sessão de
-- suporte (`support is null`, o estado normal) e sem TOTP cadastrado (o que
-- torna `fn_session_mfa_proven()` verdadeiro por ausência de fator), passa pelo
-- portão e dispara a redação IRREVERSÍVEL de contato de qualquer organização.
-- A `fn_support_write_allowed` não fecha isso: ela olha a sessão de suporte e
-- devolve `true` quando não há nenhuma.
--
-- `fn_is_platform_admin_full()` é a régua que a 0508 instalou para escrita:
-- idêntica à pura, exigindo `scope='full'`. O `and support is null` fica como
-- está — quem entra por suporte continua decidido pela primeira metade do `or`
-- (`fn_role_at_least`, que o contexto de suporte em modo `full` resolve como
-- `admin`, e em modo leitura nega). O que muda é só o atalho de plataforma:
-- `full` fora de suporte segue anonimizando (comportamento da 0229); o modo de
-- leitura não escreve por caminho nenhum.
--
-- Mesmo corpo da última definição do baseline, com esta única troca; os grants
-- são reaplicados como nas migrations anteriores desta função.
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
