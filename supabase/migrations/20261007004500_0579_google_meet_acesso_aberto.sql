-- manifest: Porta de escrita da opção "Google Meet já com acesso aberto" (issue #2063, PR #2089) — `fn_definir_google_meet_acesso_aberto`, a irmã das 0262/0343: manager, suporte de escrita e MFA conferidos por auth.uid(), chave de topo `settings.google_meet_acesso_aberto` (nunca dentro de `settings.agenda`, que a fn_agenda_settings substitui inteira), só o `true` explícito liga, e devolve {ligado,mudou}.
-- ---- Porta de escrita da opção "Meet com acesso aberto" (migration 0579) ----
--
-- Issue #2063 (PR #2089). A opção `google_meet_acesso_aberto` nasce DESLIGADA em
-- toda organização, e esta é a ÚNICA porta que a liga.
--
-- ─── Por que uma função nova, e não um UPDATE pela sessão ──────────────────
--
-- `organizations.settings` é jsonb e tem escritor para cada coisa: um UPDATE
-- direto da sessão de um Gerente de tenant casa ZERO linhas e devolve SUCESSO
-- (o defeito clássico que a action da 0262 documenta), e gravar o objeto
-- inteiro apagaria as chaves de quem já configurou. O caminho é o mesmo das
-- irmãs `fn_definir_colegas_podem_mexer_na_agenda` (0343) e
-- `fn_definir_cliente_pela_agenda` (0262): `security definer` com a guarda
-- escrita no corpo, chamada pelo Server Action com o client DA SESSÃO.
--
-- ─── Por que chave PRÓPRIA de topo, e não dentro de `settings.agenda` ──────
--
-- `fn_agenda_settings` SUBSTITUI o objeto `agenda` inteiro e recusa chave que
-- não as duas que conhece — a opção seria apagada na primeira vez que um
-- Gerente salvasse os prazos. O mesmo motivo da 0343.
--
-- Piso `manager` (é regra da AGENDA, mora na mesma tela dos prazos), suporte de
-- escrita e MFA comprovado — os três conferidos por `auth.uid()`, que só existe
-- porque o chamador usa o client da sessão e não o de service role.
--
-- Idempotente: o valor atual é lido antes de escrever, e o `||` no objeto
-- preserva as demais chaves do jsonb.

create or replace function public.fn_definir_google_meet_acesso_aberto(p_org uuid,p_ligado boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_atual boolean; v_linhas int;
begin
 if p_ligado is null then raise exception 'meet_acesso_aberto_invalido' using errcode='22023'; end if;
 if auth.uid() is null
    or not public.fn_role_at_least(p_org,'manager')
    or not public.fn_support_write_allowed(p_org) then
  raise exception 'meet_acesso_aberto_forbidden' using errcode='42501';
 end if;
 if not public.fn_session_mfa_proven() then raise exception 'mfa_required' using errcode='42501'; end if;
 -- A MESMA régua de leitura de `meetAbertoLigado` (lib/schemas/settings.ts):
 -- só o `true` explícito liga. Ausente, `false` ou qualquer lixo é desligado.
 select coalesce(settings->'google_meet_acesso_aberto' = 'true'::jsonb,false)
   into v_atual from public.organizations where id = p_org;
 if v_atual is not distinct from p_ligado then
  return jsonb_build_object('ligado',v_atual,'mudou',false);
 end if;
 -- Chave PRÓPRIA de topo (ver cabeçalho): `||` no objeto, nunca `settings.agenda`.
 update public.organizations
    set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('google_meet_acesso_aberto',to_jsonb(p_ligado))
  where id = p_org;
 get diagnostics v_linhas = row_count;
 if v_linhas = 0 then raise exception 'meet_acesso_aberto_sem_organizacao' using errcode='P0002'; end if;
 return jsonb_build_object('ligado',p_ligado,'mudou',true);
end; $$;

revoke all on function public.fn_definir_google_meet_acesso_aberto(uuid,boolean) from public,anon;
grant execute on function public.fn_definir_google_meet_acesso_aberto(uuid,boolean) to authenticated,service_role;

comment on function public.fn_definir_google_meet_acesso_aberto(uuid,boolean) is
  'Liga/desliga "Google Meet já com acesso aberto" (issue #2063, PR #2089). Gerente ou acima, suporte de escrita e MFA comprovado; ela mesma confere pelo auth.uid(). Grava settings.google_meet_acesso_aberto (chave de topo) e devolve {ligado,mudou}.';

notify pgrst, 'reload schema';
