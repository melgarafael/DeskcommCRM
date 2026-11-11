-- manifest: **Módulo conectado, F1 — o interruptor, por instalação (spec 33, D8).** `extension_installations` ganha `disabled_at` e `disabled_by` (CHECK `disabled_by is null or disabled_at is not null`); `extension_operations_kind_check` ganha o valor `'switch'` (a lista inteira vigente mais o novo); `fn_extensions_set_switch(p_actor, p_operation, p_installation, p_disabled, p_expected_installation_revision)` liga e desliga um módulo `connected` sem desinstalar, no molde de `fn_extensions_remove_installation` (recibo idempotente por impressão digital, `applied_now`, revisão da instalação como precondição, e a revisão sobe quando aplica); recusa instalação removida, revisão velha e pacote que não é `connected`. EXECUTE só para `service_role`. Espelho no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (0116); a CHECK de `kind` vive no bloco único da 0271.
-- ============================================================================
-- 9116 — MÓDULO CONECTADO, F1: o interruptor da instalação.
--
-- Um módulo `connected` é um serviço externo que lê/altera áreas do CRM (spec 33). Desligá-lo NÃO o
-- desinstala: a instalação e o recibo continuam, e a instalação ganha `disabled_at` (quando) e
-- `disabled_by` (quem). Esta tarefa só GUARDA o estado; quem o lê para negar acesso é a F2/F4.
--
-- 1. Duas colunas em `extension_installations`. Nascem nulas: nenhuma linha existente viola a CHECK.
-- 2. `'switch'` entra na CHECK de `kind` do recibo. A lista é a vigente (0271 + `module_install`,
--    da 0340) MAIS o valor novo; encolher o vocabulário reprovaria
--    `tests/unit/migrations-nao-encolhem-vocabulario.test.ts`.
-- 3. `fn_extensions_set_switch`, no molde de `fn_extensions_remove_installation`: confere o ator
--    antes e depois de cada trava, trava a instalação (`for update`), compara o recibo pela
--    impressão digital do pedido e só então confere a precondição. A ordem das recusas é: recibo
--    repetido com outro corpo, instalação inexistente, removida, preparação em curso, revisão velha,
--    pacote que não é `connected`.
--    Ligar de novo zera `disabled_at` e `disabled_by`. Desligar o que já está desligado conserva a
--    hora e o autor originais (a revisão sobe e o recibo é gravado: o pedido foi atendido).
--
-- Função nova em `public` nasce exposta (ALTER DEFAULT PRIVILEGES do baseline dá EXECUTE a `anon`, e o
-- Postgres dá a PUBLIC): as duas origens são revogadas abaixo. Idempotente.

alter table public.extension_installations
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid references auth.users(id) on delete set null;
alter table public.extension_installations drop constraint if exists extension_installations_disabled_by_requires_disabled_at;
alter table public.extension_installations add constraint extension_installations_disabled_by_requires_disabled_at
  check (disabled_by is null or disabled_at is not null);

alter table public.extension_operations drop constraint if exists extension_operations_kind_check;
alter table public.extension_operations add constraint extension_operations_kind_check
  check (kind in ('catalog_admission','install','update','revert','removal','configure','module_install','switch'));

create or replace function public.fn_extensions_set_switch(p_actor uuid, p_operation uuid, p_installation uuid,
  p_disabled boolean, p_expected_installation_revision integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request jsonb := jsonb_build_object('kind','switch','actor',p_actor,'installation',p_installation,
    'disabled',p_disabled,'expected_installation_revision',p_expected_installation_revision);
  v_op public.extension_operations; v_install public.extension_installations; v_from public.extension_installations;
  v_profile text;
begin
  perform public.fn_extensions_assert_actor(p_actor);
  if p_operation is null or p_installation is null or p_disabled is null or p_expected_installation_revision is null
    or p_expected_installation_revision < 1 then
    raise exception using errcode='P0001',message='extension_invalid_input';
  end if;
  perform pg_advisory_xact_lock(255,1);
  perform public.fn_extensions_assert_actor(p_actor);
  perform pg_advisory_xact_lock(hashtextextended(p_operation::text,255));
  perform public.fn_extensions_assert_actor(p_actor);
  select * into v_op from public.extension_operations where id=p_operation;
  if found then
    if v_op.request_fingerprint <> public.fn_extensions_fingerprint(v_request) then
      raise exception using errcode='P0001',message='extension_idempotency_conflict';
    end if;
    return to_jsonb(v_op) || jsonb_build_object('applied_now', false);
  end if;
  select * into v_install from public.extension_installations where id=p_installation for update;
  if not found then raise exception using errcode='P0001',message='extension_installation_not_found'; end if;
  if v_install.removed_at is not null then raise exception using errcode='P0001',message='extension_removed'; end if;
  if exists (select 1 from public.extension_operations where kind in ('install','update') and status='preparing'
    and catalog_id=v_install.catalog_id and publisher=v_install.publisher and name=v_install.name) then
    raise exception using errcode='P0001',message='extension_preparation_in_progress';
  end if;
  if v_install.revision <> p_expected_installation_revision then
    raise exception using errcode='P0001',message='extension_version_changed';
  end if;
  -- O perfil vem do ARTEFATO admitido (o manifesto já passou por `fn_extensions_finish_install`).
  select a.manifest->>'profile' into v_profile from public.extension_artifacts a where a.id=v_install.artifact_id;
  if v_profile is distinct from 'connected' then
    raise exception using errcode='P0001',message='extension_switch_not_applicable';
  end if;
  v_from := v_install;
  update public.extension_installations
    set disabled_at = case when p_disabled then coalesce(v_from.disabled_at, now()) else null end,
        disabled_by = case when p_disabled then coalesce(v_from.disabled_by, p_actor) else null end,
        revision = revision+1
    where id=p_installation returning * into v_install;
  insert into public.extension_operations(id,kind,status,actor_id,catalog_id,installation_id,publisher,name,version,
    request,request_fingerprint,result)
    values(p_operation,'switch','completed',p_actor,v_install.catalog_id,v_install.id,v_install.publisher,v_install.name,
      v_install.version,v_request,public.fn_extensions_fingerprint(v_request),
      jsonb_build_object('installation',to_jsonb(v_install),'from_revision',v_from.revision,'from_version',v_from.version,
        'disabled',p_disabled))
    returning * into v_op;
  return to_jsonb(v_op) || jsonb_build_object('applied_now', true);
end $$;

revoke execute on function public.fn_extensions_set_switch(uuid,uuid,uuid,boolean,integer) from public, anon, authenticated;
grant execute on function public.fn_extensions_set_switch(uuid,uuid,uuid,boolean,integer) to service_role;

notify pgrst, 'reload schema';
