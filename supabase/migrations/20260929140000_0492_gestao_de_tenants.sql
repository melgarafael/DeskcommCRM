-- 0492 — Gestão de tenants pelo admin da plataforma: suspensão que corta de
-- verdade, exclusão completa e transacional, e o inventário de arquivos da
-- organização no Storage.
--
-- ── 1. ORGANIZAÇÃO SUSPENSA SAI DO ALCANCE DA RLS ────────────────────────────
--
-- `organizations.status` existia (`active|suspended|redacted|archived`), mas
-- nenhum helper de RLS o lia: suspender gravava a coluna e só a TELA de `/app`
-- redirecionava. Com o JWT do usuário (entregue ao browser pelo
-- `/api/v1/auth/realtime-token`) o PostgREST e o Realtime seguiam servindo a
-- organização suspensa por inteiro — auditoria de 28/09/2026, achado P3.
--
-- O corte mora nos DOIS helpers de que toda policy de tenant depende:
-- `fn_user_org_ids()` (isolamento) e `fn_user_role_in_org()` (papel — e, por
-- tabela, `fn_role_at_least` e `fn_user_role_in`). Só o ramo de MEMBRO muda: o
-- ramo de acompanhamento (suporte) já exige `status = 'active'` dentro de
-- `fn_support_context()`, e o admin de plataforma entra por
-- `fn_is_platform_admin()`, que é outro caminho.
--
-- O que NÃO muda de propósito: `user_organizations` continua legível pelo
-- próprio usuário (`user_orgs_select` casa `user_id = auth.uid()`), então a
-- aplicação ainda sabe que a pessoa pertence a uma organização suspensa e pode
-- mostrar a tela certa em vez de "você não pertence a nenhuma empresa".

create or replace function public.fn_user_org_ids()
returns setof uuid language sql stable security definer set search_path = public as $f$
 select uo.organization_id
   from public.user_organizations uo
   join public.organizations o on o.id = uo.organization_id and o.status = 'active'
  where uo.user_id = auth.uid() and uo.revoked_at is null
 union select (s->>'organization_id')::uuid from (select public.fn_support_context() s) c where s->>'status'='active';
$f$;

create or replace function public.fn_user_role_in_org(p_org uuid)
returns text language sql stable security definer set search_path = public as $f$
 select case when s->>'status'='active' and (s->>'organization_id')::uuid=p_org
 then case when s->>'access_mode'='full' then 'admin' else 'viewer' end
 else (select uo.role
         from public.user_organizations uo
         join public.organizations o on o.id = uo.organization_id and o.status = 'active'
        where uo.user_id=auth.uid() and uo.organization_id=p_org and uo.revoked_at is null
        limit 1) end
 from (select public.fn_support_context() s) c;
$f$;

-- ── 2. EXCLUSÃO COMPLETA DA ORGANIZAÇÃO ──────────────────────────────────────
--
-- Não existia exclusão de tenant. Um `delete from organizations` avulso
-- cascateia por ~155 tabelas, mas tem três armadilhas medidas no mapa de
-- dependências (29/09/2026):
--
--  * R1 — lead atribuído a agente de IA: o BEFORE DELETE de `ai_agents` solta
--    o lead, o UPDATE dispara `emit_event`, e o INSERT em `event_log` aponta
--    para a organização que a própria cascata acabou de apagar → a FK falha e a
--    transação inteira aborta. Apagar os leads ANTES, com a org viva, tira esse
--    caminho da cascata.
--  * `webhook_events_log` não tem FK para `organizations`: sobraria com o corpo
--    cru dos webhooks (telefones, textos). É apagada explicitamente.
--  * A auditoria sobrevive (FK `set null`), mas perde a atribuição. Por isso a
--    função grava ANTES uma lápide (`organization.deleted`) com `resource_id` =
--    a organização — é por ela que a trilha continua achável — e o resumo do que
--    a LGPD exige guardar (`lgpd_requests`, que o cascade apaga).
--
-- Pré-condição: a organização precisa estar SUSPENSA. A exclusão é o segundo
-- passo de uma decisão, nunca o primeiro — e a suspensão já deixou o tenant
-- parado (nada entra pela RLS, nada sai pelos workers) antes de sumir.
--
-- Roda SÓ como servidor (service_role, `auth.uid()` nulo): o gatilho
-- `fn_followup_generation_write` recusa DELETE em `job_queue` vindo de sessão
-- de usuário, e a exclusão não é ato de membro nenhum.

create or replace function public.fn_excluir_organizacao(
  p_org uuid,
  p_actor uuid,
  p_confirmacao text,
  p_motivo text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $f$
declare
  v_org record;
  v_membros uuid[];
  v_removiveis uuid[];
  v_contagens jsonb;
  v_lgpd jsonb;
  v_suporte jsonb;
  v_tabela regclass;
  v_sobra bigint;
begin
  if auth.uid() is not null then
    raise exception 'organizacao_exclusao_so_pelo_servidor' using errcode = '42501';
  end if;
  if p_motivo is null or length(btrim(p_motivo)) < 10 then
    raise exception 'organizacao_exclusao_sem_motivo' using errcode = '22023';
  end if;

  select id, slug, display_name, legal_name, cnpj, status, created_at
    into v_org
    from public.organizations
   where id = p_org
   for update;
  if not found then
    raise exception 'organizacao_inexistente' using errcode = 'PT404';
  end if;
  if v_org.status <> 'suspended' then
    raise exception 'organizacao_nao_suspensa' using errcode = 'PT409';
  end if;
  if p_confirmacao is distinct from v_org.slug then
    raise exception 'organizacao_confirmacao_divergente' using errcode = '22023';
  end if;

  select coalesce(array_agg(user_id), '{}') into v_membros
    from public.user_organizations where organization_id = p_org;

  select jsonb_build_object(
    'membros', coalesce(array_length(v_membros, 1), 0),
    'contatos', (select count(*) from public.contacts where organization_id = p_org),
    'conversas', (select count(*) from public.conversations where organization_id = p_org),
    'mensagens', (select count(*) from public.messages where organization_id = p_org),
    'leads', (select count(*) from public.crm_leads where organization_id = p_org),
    'canais', (select count(*) from public.channel_sessions where organization_id = p_org)
  ) into v_contagens;

  -- O que a LGPD exige guardar e o cascade apagaria: o atendimento a titular
  -- (tipo, situação, prazos). Sem conteúdo nem contato — só a prova de que o
  -- pedido existiu e como terminou.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'tipo', request_type, 'escopo', scope, 'origem', source,
           'situacao', status, 'recebido_em', received_at, 'prazo', due_at,
           'concluido_em', completed_at) order by received_at), '[]'::jsonb)
    into v_lgpd
    from public.lgpd_requests where organization_id = p_org;

  -- Quem da plataforma entrou nesta organização: o registro some com o cascade.
  select coalesce(jsonb_agg(jsonb_build_object(
           'ator', actor_user_id, 'modo', access_mode,
           'inicio', created_at, 'fim', ended_at) order by created_at), '[]'::jsonb)
    into v_suporte
    from public.platform_support_sessions where organization_id = p_org;

  -- A lápide: `organization_id` nulo de propósito (a linha sobrevive à
  -- exclusão sem depender do SET NULL), `resource_id` = a organização.
  insert into public.api_audit_log
    (organization_id, actor_user_id, acting_as_platform_admin, action,
     resource_type, resource_id, request_id, bypassed_rls, metadata)
  values
    (null, p_actor, true, 'organization.deleted', 'organization', p_org,
     p_request_id, true,
     jsonb_build_object(
       'slug', v_org.slug, 'display_name', v_org.display_name,
       'legal_name', v_org.legal_name, 'cnpj', v_org.cnpj,
       'criada_em', v_org.created_at, 'motivo', btrim(p_motivo),
       'contagens', v_contagens, 'lgpd_requests', v_lgpd,
       'acompanhamentos_de_suporte', v_suporte));

  -- R1: tira o caminho agente → lead → event_log da cascata.
  delete from public.crm_leads where organization_id = p_org;

  -- Sem FK para organizations: sairia órfã com o corpo cru dos webhooks.
  delete from public.webhook_events_log
   where organization_id = p_org
      or channel_session_id in (select id from public.channel_sessions where organization_id = p_org);

  delete from public.organizations where id = p_org;

  -- Conferência: nenhuma tabela pode guardar linha desta organização — vale
  -- também para as tabelas que módulos criam em runtime (ADR-0002).
  for v_tabela in
    select a.attrelid::regclass
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where a.attname = 'organization_id' and not a.attisdropped
  loop
    execute format('select count(*) from %s where organization_id = $1', v_tabela)
      into v_sobra using p_org;
    if v_sobra > 0 then
      raise exception 'organizacao_exclusao_incompleta: % linha(s) em %', v_sobra, v_tabela
        using errcode = 'P0001';
    end if;
  end loop;

  -- Logins que pertenciam SÓ a esta organização. Quem tem vínculo com outra
  -- (inclusive revogado — o CASCADE de `auth.users` apagaria o histórico de lá),
  -- é admin da plataforma ou conduziu acompanhamento em outra org fica.
  select coalesce(array_agg(u), '{}') into v_removiveis
    from unnest(v_membros) as u
   where not exists (select 1 from public.user_organizations where user_id = u)
     and not exists (select 1 from public.platform_admins where user_id = u)
     and not exists (select 1 from public.platform_support_sessions where actor_user_id = u);

  return jsonb_build_object(
    'organizacao', p_org,
    'slug', v_org.slug,
    'contagens', v_contagens,
    'membros', to_jsonb(v_membros),
    'usuarios_removiveis', to_jsonb(v_removiveis));
end;
$f$;

revoke execute on function public.fn_excluir_organizacao(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_excluir_organizacao(uuid, uuid, text, text, text) to service_role;

-- ── 3. ARQUIVOS DA ORGANIZAÇÃO NO STORAGE ────────────────────────────────────
--
-- Todo bucket tenant-aware guarda sob `<organization_id>/…` (whatsapp-media,
-- ai-policy, lgpd-exports, skill-assets, brand-logos, catalog-photos,
-- org-sounds). A API do Storage só lista uma pasta por vez; esta função devolve
-- o inventário inteiro pelo prefixo, para a exclusão remover pela API (apagar
-- `storage.objects` direto deixaria o arquivo no backend).

create or replace function public.fn_arquivos_da_organizacao(p_org uuid)
returns table (bucket_id text, name text)
language sql
stable
security definer
set search_path = public, storage
as $f$
  select o.bucket_id, o.name
    from storage.objects o
   where o.name like p_org::text || '/%';
$f$;

revoke execute on function public.fn_arquivos_da_organizacao(uuid) from public, anon, authenticated;
grant execute on function public.fn_arquivos_da_organizacao(uuid) to service_role;

-- ── 4. FOLLOW-UP DE ORGANIZAÇÃO SUSPENSA FICA PARADO ────────────────────────
--
-- O motor de follow-up reserva inscrições vencidas por esta função, sem olhar a
-- organização: suspender não parava o avanço dos fluxos. Mesmo corpo da última
-- definição (0212/rodízio por organização), com UMA condição a mais na CTE
-- `orgs`: só organização ATIVA entra no rodízio. As inscrições da suspensa
-- continuam vencidas e intactas — reativar as devolve à fila, nada se perde.

create or replace function fn_claim_due_followup_enrollments(p_limit int, p_lease_seconds int)
returns setof followup_enrollments
language sql
security definer
set search_path = public
as $$
  with orgs as (
    select distinct f.organization_id
      from followup_enrollments f
      join organizations o on o.id = f.organization_id and o.status = 'active'
     where f.status in ('active','waiting_reply','dormente')
       and f.next_eval_at <= now()
  ),
  fila as (
    select f.id, f.next_eval_at, f.posicao_na_org
      from orgs
      cross join lateral (
        select d.id,
               d.next_eval_at,
               row_number() over (order by d.next_eval_at) as posicao_na_org
          from followup_enrollments d
         where d.organization_id = orgs.organization_id
           and d.status in ('active','waiting_reply','dormente')
           and d.next_eval_at <= now()
           and (d.claimed_until is null or d.claimed_until < now())
         order by d.next_eval_at
         limit p_limit
      ) f
  ),
  escolhidos as (
    select id from fila order by posicao_na_org, next_eval_at limit p_limit
  ),
  travados as (
    select e.id from followup_enrollments e
     where e.id in (select id from escolhidos)
     for update skip locked
  )
  update followup_enrollments e
     set claimed_until = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where e.id in (select id from travados)
     -- Lease repetido no UPDATE: ver o comentário da definição anterior
     -- (concorrência em READ COMMITTED, followup-schema.test.ts).
     and (e.claimed_until is null or e.claimed_until < now())
  returning e.*;
$$;

revoke execute on function fn_claim_due_followup_enrollments(int, int) from public, anon, authenticated;
grant execute on function fn_claim_due_followup_enrollments(int, int) to service_role;
