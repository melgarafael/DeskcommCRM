-- 20260928003000_0464_proposta_comercial.sql
--
-- A organização emite para um contato, com itens, valor e prazo, cujo desfecho volta para o funil. Ver
-- docs/superpowers/specs/2026-09-16-proposta-comercial-design.md.
--
-- Numeração e versão são decisão do dono (spec §5.3/§5.4): numero+ano
-- nascem NULL no rascunho — só existem quando a proposta é ENVIADA — e uma
-- revisão de proposta enviada cria uma v2 que HERDA o número da v1.

create table if not exists public.crm_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  status text not null default 'rascunho'
    check (status in ('rascunho','enviada','aceita','recusada','vencida','cancelada','substituida')),
  titulo text not null,
  condicoes text,
  total_cents bigint not null default 0,
  moeda text not null default 'BRL',
  valid_until date,
  pdf_path text,
  numero integer,
  ano integer,
  versao integer not null default 1,
  substitui_id uuid references public.crm_proposals(id) on delete set null,
  drafted_by_agent_id uuid references public.ai_agents(id) on delete set null,
  revision bigint not null default 1,
  sent_at timestamptz,
  sent_by_user_id uuid references auth.users(id),
  decided_at timestamptz,
  decided_by_user_id uuid references auth.users(id),
  decision_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_proposals_moeda_iso check (moeda ~ '^[A-Z]{3}$'),
  constraint crm_proposals_total_nao_negativo check (total_cents >= 0),
  constraint crm_proposals_numero_ano_juntos check ((numero is null) = (ano is null))
);

create index if not exists crm_proposals_org_lead_idx
  on public.crm_proposals(organization_id, lead_id);
create index if not exists crm_proposals_org_status_idx
  on public.crm_proposals(organization_id, status);
-- Só uma proposta pode ocupar um número por organização/ano — parcial porque
-- rascunho nunca tem numero/ano. `status <> 'substituida'` de propósito: é o
-- que permite a v2 herdar o MESMO numero/ano da v1 quando uma proposta
-- ENVIADA é revisada (spec §5.4) — a v1 continua existindo como linha
-- legível, marcada `substituida`, e sai da unicidade para abrir espaço para a
-- v2. Quem cria a v2 (Tarefa 14) marca a v1 como substituida ANTES de, ou na
-- mesma operação que, grava o numero em v2 — senão o índice ainda bloqueia
-- por uma fração de segundo. Responsabilidade de quem escrever a Tarefa 14.
drop index if exists crm_proposals_numero_ano_org_uidx;
create unique index if not exists crm_proposals_numero_ano_org_uidx
  on public.crm_proposals(organization_id, ano, numero)
  where numero is not null and status <> 'substituida';

create table if not exists public.crm_proposal_items (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.crm_proposals(id) on delete cascade,
  -- Desnormalizado de crm_proposals.organization_id: toda tabela tenant-aware
  -- precisa da própria coluna (CLAUDE.md) para a trava de suporte
  -- (fn_aplicar_travas_de_suporte, migration 0274) alcançar esta tabela — a
  -- função seleciona por `pg_attribute.attname = 'organization_id'`, e uma
  -- tabela sem a coluna cai fora da trava (nem protegida, nem exempta).
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid references public.catalog_products(id) on delete set null,
  descricao text not null,
  quantidade numeric not null default 1,
  preco_unitario_cents bigint not null,
  desconto_cents bigint not null default 0,
  -- fractional indexing, igual position_in_stage — NUNCA int (CLAUDE.md).
  position numeric not null,
  created_at timestamptz not null default now(),
  constraint crm_proposal_items_quantidade_positiva check (quantidade > 0),
  constraint crm_proposal_items_preco_nao_negativo check (preco_unitario_cents >= 0),
  constraint crm_proposal_items_desconto_nao_negativo check (desconto_cents >= 0)
);
create index if not exists crm_proposal_items_proposal_idx
  on public.crm_proposal_items(proposal_id, position);
create index if not exists crm_proposal_items_org_idx
  on public.crm_proposal_items(organization_id);

-- A policy de write de crm_proposal_items (abaixo) filtra direto por
-- `organization_id` da PRÓPRIA linha — desde a correção do Important 4 da
-- revisão, ela não confere mais, sozinha, que esse organization_id bate com o
-- dono real da proposta referenciada por `proposal_id`. Sem esta trava, um
-- INSERT com organization_id = A e proposal_id de uma proposta que pertence a
-- B passaria pela RLS (que só olha o organization_id da linha) e quebraria o
-- isolamento entre tenants — não há FK composta nem CHECK que amarre as duas
-- colunas. Mesmo padrão já usado em `fn_validate_activity_lead_org`
-- (crm_lead_activities.lead_id → crm_leads.organization_id). A cláusula
-- "not found" não é necessária aqui: `proposal_id` já tem FK not null para
-- crm_proposals(id), então a linha referenciada sempre existe no momento do
-- INSERT/UPDATE.
create or replace function public.fn_verificar_org_do_item_da_proposta()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.crm_proposals where id = new.proposal_id;
  if v_org is distinct from new.organization_id then
    raise exception 'crm_proposal_item_org_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crm_proposal_items_org_consistente on public.crm_proposal_items;
create trigger trg_crm_proposal_items_org_consistente
  before insert or update on public.crm_proposal_items
  for each row execute function public.fn_verificar_org_do_item_da_proposta();

-- Função de gatilho: não é RPC, mas nasce com EXECUTE para public e anon
-- como qualquer função em public (CLAUDE.md, Migrations item 9).
revoke execute on function public.fn_verificar_org_do_item_da_proposta() from public, anon;

alter table public.crm_proposals enable row level security;
alter table public.crm_proposal_items enable row level security;

-- Leitura: qualquer papel da organização. A escrita espelha as ROTAS, por
-- operação — o PostgREST é porta tão aberta quanto elas (o JWT da sessão fala
-- com ele direto; ver 0150):
--   INSERT  `agent`, e só rascunho (POST /proposals);
--   UPDATE  `agent`, em rascunho (editar) ou enviada (decidir) — a TRANSIÇÃO
--           é conferida pelo gatilho `trg_crm_proposals_transicao_da_sessao`,
--           porque policy permissiva não vê o `old` e casaria o USING de uma
--           com o CHECK de outra;
--   DELETE  `manager`, e só rascunho — enviada é documento, ninguém apaga.
-- Enviar, numerar e revisar são do servidor (service_role), nunca da sessão.
-- SELECT tem o bypass de suporte da plataforma (molde de catalog_products);
-- a escrita não tem, de propósito.
drop policy if exists crm_proposals_select on public.crm_proposals;
create policy crm_proposals_select on public.crm_proposals
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists crm_proposals_write on public.crm_proposals;
drop policy if exists crm_proposals_insert on public.crm_proposals;
create policy crm_proposals_insert on public.crm_proposals
  for insert
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'agent')
              and status = 'rascunho');

drop policy if exists crm_proposals_update on public.crm_proposals;
create policy crm_proposals_update on public.crm_proposals
  for update
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'agent')
         and status in ('rascunho', 'enviada'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'agent'));

drop policy if exists crm_proposals_delete on public.crm_proposals;
create policy crm_proposals_delete on public.crm_proposals
  for delete
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager')
         and status = 'rascunho');

-- A sessão (PostgREST, papel `authenticated`) só faz o que uma rota faz. O
-- servidor (`service_role`) e as funções `security definer` não passam por
-- aqui: `current_user` delas não é o da sessão. INVOKER de propósito, como
-- `fn_meet_stamp`.
create or replace function public.fn_crm_proposals_transicao_da_sessao()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  -- o que só o ENVIO escreve (numeração, arquivo, mensagem, retorno)
  v_envio constant text[] := array['numero', 'ano', 'versao', 'substitui_id', 'sent_at',
    'sent_by_user_id', 'pdf_path', 'message_id', 'retorno_id', 'template_snapshot', 'rendered_snapshot'];
  -- o que decidir e descartar mudam
  v_decisao constant text[] := array['status', 'decided_at', 'decided_by_user_id',
    'decision_reason', 'updated_at'];
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from unnest(v_envio) k where k <> 'versao' and v_new -> k <> 'null'::jsonb)
       or coalesce(v_new ->> 'versao', '1') <> '1' then
      raise exception 'proposta_envio_e_do_servidor' using errcode = '42501';
    end if;
    return new;
  end if;
  v_old := to_jsonb(old);
  if old.status = 'rascunho' and new.status = 'rascunho' then
    -- editar o rascunho: o conteúdo muda, o que é do envio não
    if exists (select 1 from unnest(v_envio) k where v_new -> k is distinct from v_old -> k) then
      raise exception 'proposta_envio_e_do_servidor' using errcode = '42501';
    end if;
  elsif (old.status = 'enviada' and new.status in ('aceita', 'recusada'))
     or (old.status = 'rascunho' and new.status = 'cancelada'
         and public.fn_role_at_least(new.organization_id, 'manager')) then
    -- decidir (agent) ou descartar (manager): só a decisão muda
    if (v_new - v_decisao) is distinct from (v_old - v_decisao) then
      raise exception 'proposta_transicao_negada' using errcode = '42501';
    end if;
  else
    raise exception 'proposta_transicao_negada' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_crm_proposals_transicao_da_sessao() from public, anon;

drop trigger if exists trg_crm_proposals_transicao_da_sessao on public.crm_proposals;
create trigger trg_crm_proposals_transicao_da_sessao
  before insert or update on public.crm_proposals
  for each row execute function public.fn_crm_proposals_transicao_da_sessao();

-- organization_id direto na linha (não mais join com crm_proposals): mais
-- simples, mais rápido, e é o que a trava de suporte (0274) precisa medir.
drop policy if exists crm_proposal_items_select on public.crm_proposal_items;
create policy crm_proposal_items_select on public.crm_proposal_items
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Item só se escreve em RASCUNHO (POST/PATCH/assistente, todos `agent`): o
-- item de uma proposta enviada é o que o cliente recebeu, e a v2 é clonada
-- pelo servidor. O `delete` do rascunho leva os itens pela FK, sem RLS.
drop policy if exists crm_proposal_items_write on public.crm_proposal_items;
create policy crm_proposal_items_write on public.crm_proposal_items
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'agent')
         and exists (select 1 from public.crm_proposals p
                      where p.id = crm_proposal_items.proposal_id
                        and p.organization_id = crm_proposal_items.organization_id
                        and p.status = 'rascunho'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'agent')
              and exists (select 1 from public.crm_proposals p
                           where p.id = crm_proposal_items.proposal_id
                             and p.organization_id = crm_proposal_items.organization_id
                             and p.status = 'rascunho'));

revoke all on public.crm_proposals from anon;
revoke all on public.crm_proposal_items from anon;
grant select, insert, update, delete on public.crm_proposals to authenticated;
grant select, insert, update, delete on public.crm_proposal_items to authenticated;
grant all on public.crm_proposals to service_role;
grant all on public.crm_proposal_items to service_role;

drop trigger if exists trg_crm_proposals_updated_at on public.crm_proposals;
create trigger trg_crm_proposals_updated_at
  before update on public.crm_proposals
  for each row execute function public.fn_set_updated_at();

comment on table public.crm_proposals is
  'Documento comercial emitido para um contato: itens, valor, prazo. Desfecho volta ao funil.';
comment on column public.crm_proposals.numero is
  'Nasce NULL. Alocado só no ENVIO — rascunho descartado não queima número (spec §5.3).';
comment on column public.crm_proposals.versao is
  'v2 herda numero/ano da v1 quando uma proposta ENVIADA é revisada (spec §5.4).';
comment on column public.crm_proposals.revision is
  'Concorrência otimista do EDITOR: incrementa a cada PATCH de rascunho ou aplicação do assistente. Diferente de `versao`, que é a versão pós-envio, visível ao cliente no PDF.';

-- Numeração: aloca dentro da MESMA transação do envio. A rota que chama isto
-- (Tarefa 14) captura 23505 (unique_violation do índice parcial acima) e
-- tenta de novo — é o padrão de idempotência que o repositório já usa.
create or replace function public.fn_proposta_aloca_numero(p_org uuid, p_ano int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(numero), 0) + 1
  from public.crm_proposals
  where organization_id = p_org and ano = p_ano;
$$;

-- Só service_role chama (a rota de envio, Tarefa 14, usa createAdminClient()).
-- NUNCA authenticated: a função não confere se p_org pertence a quem chama —
-- exposta a authenticated seria RPC cross-tenant (qualquer usuário logado
-- aprenderia a numeração de outra organização passando o organization_id dela).
revoke all on function public.fn_proposta_aloca_numero(uuid, int) from public, anon, authenticated;
grant execute on function public.fn_proposta_aloca_numero(uuid, int) to service_role;

-- Bucket privado, URL sempre assinada — mesmo padrão de `lgpd-exports`
-- (file_size_limit/allowed_mime_types inclusive; só PDF faz sentido aqui).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('propostas', 'propostas', false, 52428800, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "propostas: leitura por organizacao" on storage.objects;
create policy "propostas: leitura por organizacao" on storage.objects
  for select using (
    bucket_id = 'propostas'
    and (split_part(name, '/', 1))::uuid in (select public.fn_user_org_ids())
  );

-- Sem policy de escrita: `service_role` ignora RLS (é o papel que faz bypass),
-- então uma policy aqui seria decorativa — mesmo padrão dos outros buckets do
-- produto (`lgpd-exports`, `skill-assets`), nenhum deles tem uma. `auth.role()`
-- também não existe fora de um projeto Supabase real, e quebrava o Postgres
-- efêmero do CI (test:db) ao aplicar o baseline.

-- Três `kind` novos em agent_inbox_items. Medido em 2026-09-17 contra
-- supabase/baseline.sql: `agent_inbox_items_kind_check` reconstruída aqui com
-- a lista COMPLETA (os valores vigentes + os 3 novos + 'other') porque esta é
-- a última migration da cadeia a tocar essa constraint — a cadeia
-- (`supabase db push`) não tem o "bloco único" do apêndice do baseline.sql, e
-- `tests/unit/kind-check-migration-x-baseline.test.ts` cobra que a ÚLTIMA
-- migration que a reconstrói bata, valor a valor, com o baseline.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required', 'appointment_recovery_review', 'qr_rescan',
    'routing_unassigned', 'job_dead', 'event_dead', 'budget_exceeded', 'handoff',
    'promotion_review', 'judge_unaligned', 'followup_dead', 'snooze_expired',
    'next_action_ambiguous', 'risk_backlog_seeded', 'reactivation_expired', 'capabilities_missing',
    'message_send_stuck', 'midia_nao_lida', 'channel_template_review', 'channel_number_alert',
    'promise_unfulfilled', 'contact_proposal_expired', 'budget_warning',
    'conhecimento_nao_indexado', 'voice_call_missed', 'case_stale', 'aviso_de_caso_nao_entregue',
    'followup_sem_agente', 'canal_mudo_sem_numero', 'proposal_expired_notice',
    'proposal_acceptance_rate_drop', 'proposal_promised_not_created',
    'other'
  ));

-- A tarefa gravada a partir de um aviso de promessa (Tarefa 1) precisa dizer
-- DE ONDE veio, sem exigir que toda `crm_tasks` tenha origem — vocabulário
-- ABERTO (sem CHECK), mesmo padrão de `crm_lead_activities.type` (CLAUDE.md
-- doutrina de Migrations, exceção DIRC): o emissor usa a constante
-- compartilhada de `lib/tarefas/vocabulario-de-origem.ts`, nunca string solta.
alter table public.crm_tasks
  add column if not exists source_kind text;
comment on column public.crm_tasks.source_kind is
  'De onde a tarefa nasceu (ex.: promised_proposal). NULL = criada à mão. Vocabulário aberto — TypeScript, sem CHECK.';
