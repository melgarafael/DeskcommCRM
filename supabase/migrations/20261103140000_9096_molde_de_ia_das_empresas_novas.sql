-- manifest: **O molde de IA das empresas novas.** `platform_settings.molde_de_ia_org_id` (FK para `organizations`, `on delete set null`, nulo por padrão = comportamento de antes) escolhe a empresa cuja IA as novas copiam ao nascer. `fn_molde_de_ia_na_org_nova` (gatilho AFTER INSERT, definer) copia as `ai_purpose_bindings` do molde com `credential_id` nulo, só as sem `base_url` e de provedor com chave da instalação (anthropic, openai, openrouter), e audita `ai.molde_de_ia_aplicado` na empresa nova; `fn_seed_org_llm_defaults` (BEFORE INSERT) ganha o degrau do molde para `settings.llm`. Gatilho e não código porque só `organizations` está nos quatro caminhos de criação. Nunca copia credencial, Jev, agente nem base de conhecimento.
--
-- 9096 — o molde de IA das empresas novas.
--
-- O dono da instalação escolhe, em Painel › Recursos opcionais, UMA empresa
-- como molde (`platform_settings.molde_de_ia_org_id`). Toda empresa que nascer
-- depois disso recebe a escolha de modelo por função do molde
-- (`ai_purpose_bindings`) e o padrão dele (`settings.llm`). Nulo — o default —
-- é o comportamento de antes, intacto: a empresa nasce sem escolha por função e
-- com o padrão do produto.
--
-- POR QUE GATILHO, e não um passo no código: há quatro caminhos de criação
-- (cadastro em `lib/auth/provision.ts`, Painel › Empresas › Nova, a RPC
-- `fn_create_tenant_with_owner` e o `bootstrap-owner`), e só `organizations`
-- passa por todos. O gatilho não faz HTTP: só lê e grava linhas no banco.
--
-- AS DUAS METADES, e por que o padrão não fica no AFTER:
--   1. `fn_seed_org_llm_defaults` (BEFORE INSERT, 0096) ganha um degrau: sem
--      `default_model` vindo de quem cria, vale o do molde; sem molde, o do
--      produto, como antes. Um lugar só decide o padrão de quem nasce, sem
--      depender da ordem alfabética entre dois gatilhos BEFORE — e o INSERT
--      devolve (`returning`) o mesmo `settings` que fica gravado, o que um
--      UPDATE no AFTER não garantiria.
--   2. `fn_molde_de_ia_na_org_nova` (AFTER INSERT, novo) copia as funções — em
--      BEFORE a linha da empresa ainda não existe para a FK — e registra o
--      efeito em `api_audit_log` (`ai.molde_de_ia_aplicado`).
--
-- O QUE SE COPIA: `purpose`, `provider`, `model_id` e `is_enabled`, com
-- `credential_id` NULO (= a chave da instalação). O QUE NÃO SE COPIA: linha com
-- `base_url` (o endereço é do molde), provedor sem chave da instalação — a
-- lista é de ENTRADA: anthropic, openai, openrouter, a mesma de
-- `VARIAVEL_DA_CHAVE` em `lib/instalacao/ambiente.ts` e de
-- `PROVEDORES_DO_MOLDE` em `lib/ai/molde-de-ia.ts` —, credenciais, Jev,
-- agentes e base de conhecimento.
--
-- Molde apagado: a FK zera a coluna (`on delete set null`) e a próxima empresa
-- nasce como antes. Molde sem nada copiável: nada acontece e nada é auditado
-- (rodada sem efeito não é mutação).

alter table public.platform_settings
  add column if not exists molde_de_ia_org_id uuid
    references public.organizations(id) on delete set null;

comment on column public.platform_settings.molde_de_ia_org_id is
  'Empresa cuja configuração de IA as empresas NOVAS copiam ao nascer (migration 9096): as funções de ai_purpose_bindings sem endpoint próprio e de provedor com chave da instalação (anthropic, openai, openrouter), sempre com credential_id nulo, e o padrão settings.llm (provider, default_model). Nunca credenciais, Jev, agentes nem base de conhecimento. null = cada empresa nasce com o padrão do produto. Quem copia: fn_molde_de_ia_na_org_nova e fn_seed_org_llm_defaults. Escrita por app/actions/settings/updateMoldeDeIa.ts.';

-- O padrão do molde, quando há um molde e o padrão dele serve à empresa nova.
-- Definer porque lê `platform_settings` (sem policy, só service_role) e a linha
-- de OUTRA organização; quem chama são os dois gatilhos abaixo, também definer.
create or replace function public.fn_llm_do_molde_de_ia()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_llm jsonb;
begin
  select jsonb_build_object(
           'provider', o.settings->'llm'->>'provider',
           'default_model', o.settings->'llm'->>'default_model')
    into v_llm
    from public.platform_settings ps
    join public.organizations o on o.id = ps.molde_de_ia_org_id
   where ps.id = 1
     and o.settings->'llm'->>'provider' in ('anthropic', 'openai', 'openrouter')
     and coalesce(btrim(o.settings->'llm'->>'default_model'), '') <> '';
  return v_llm;
end;
$$;

revoke execute on function public.fn_llm_do_molde_de_ia() from public, anon, authenticated;

-- O padrão de quem nasce: o que veio de quem cria, senão o do molde, senão o do
-- produto. Corpo da 0096 com o degrau do molde no meio. Passa a ser definer
-- (com `search_path` vazio) para a leitura do molde não depender do papel de
-- quem insere a organização.
create or replace function public.fn_seed_org_llm_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_llm jsonb;
begin
  if coalesce(new.settings->'llm'->>'default_model', '') = '' then
    v_llm := public.fn_llm_do_molde_de_ia();
    if v_llm is null then
      v_llm := jsonb_build_object(
        'provider', 'anthropic',
        'default_model', coalesce(
          (select m.model_id from public.ai_models m
            where m.provider = 'anthropic' and m.is_default_for_provider
              and m.deprecated_at is null limit 1),
          'claude-sonnet-4-6'));
    end if;
    new.settings := jsonb_set(
      coalesce(new.settings, '{}'::jsonb),
      '{llm}',
      coalesce(new.settings->'llm', '{}'::jsonb) || v_llm,
      true);
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_seed_org_llm_defaults() from public, anon, authenticated;

-- As funções do molde vão para a empresa nova, e o efeito fica na auditoria
-- DELA — é onde Painel › Empresas › [empresa] o lê.
create or replace function public.fn_molde_de_ia_na_org_nova()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_molde          uuid;
  v_copiadas       integer := 0;
  v_deixadas       integer := 0;
  v_llm            jsonb;
  v_padrao_copiado boolean;
begin
  select ps.molde_de_ia_org_id into v_molde
    from public.platform_settings ps
   where ps.id = 1;
  if v_molde is null then
    return null;
  end if;

  with copiadas as (
    insert into public.ai_purpose_bindings
      (organization_id, purpose, provider, credential_id, model_id, base_url, is_enabled)
    select new.id, b.purpose, b.provider, null::uuid, b.model_id, null::text, b.is_enabled
      from public.ai_purpose_bindings b
     where b.organization_id = v_molde
       and nullif(btrim(b.base_url), '') is null
       and b.provider in ('anthropic', 'openai', 'openrouter')
    on conflict (organization_id, purpose) do nothing
    returning 1
  )
  select count(*) into v_copiadas from copiadas;

  select count(*) into v_deixadas
    from public.ai_purpose_bindings b
   where b.organization_id = v_molde
     and not (nullif(btrim(b.base_url), '') is null
              and b.provider in ('anthropic', 'openai', 'openrouter'));

  -- O padrão foi decidido pelo BEFORE (`fn_seed_org_llm_defaults`); aqui só se
  -- confere se ele é o do molde, para a auditoria dizer a verdade.
  v_llm := public.fn_llm_do_molde_de_ia();
  v_padrao_copiado := v_llm is not null
    and ((new.settings->'llm')->>'provider') is not distinct from (v_llm->>'provider')
    and ((new.settings->'llm')->>'default_model') is not distinct from (v_llm->>'default_model');

  if v_copiadas = 0 and not v_padrao_copiado then
    return null;
  end if;

  insert into public.api_audit_log
    (organization_id, action, resource_type, resource_id, bypassed_rls, metadata)
  values (
    new.id, 'ai.molde_de_ia_aplicado', 'organization', new.id, true,
    jsonb_build_object(
      'molde_org_id', v_molde,
      'funcoes_copiadas', v_copiadas,
      'funcoes_deixadas', v_deixadas,
      'padrao_copiado', v_padrao_copiado,
      'padrao', case when v_padrao_copiado then v_llm end));
  return null;
end;
$$;

revoke execute on function public.fn_molde_de_ia_na_org_nova() from public, anon, authenticated;

drop trigger if exists trg_molde_de_ia_na_org_nova on public.organizations;
create trigger trg_molde_de_ia_na_org_nova
  after insert on public.organizations
  for each row execute function public.fn_molde_de_ia_na_org_nova();

notify pgrst, 'reload schema';
