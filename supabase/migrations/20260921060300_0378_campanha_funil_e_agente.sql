-- 0378 — A CAMPANHA DECLARA FUNIL, ETAPA E AGENTE
--
-- Três colunas nullable em `campaigns`, e o índice que o degrau novo do
-- roteamento precisa. Aditiva: campanha que já existe continua com tudo NULL e
-- se comporta exatamente como antes.
--
-- ═══ `pipeline_id` / `stage_id` — onde o card nasce ═══
--
-- Hoje quem decide o funil de um lead nascido de conversa é o NÚMERO
-- (`crm_pipelines.channel_session_id`, migration 0262), com o funil padrão sem
-- número como reserva. A campanha passa a poder dizer o funil e a etapa, e
-- VENCE o número quando declara — decisão do dono (2026-09-19): quem montou a
-- campanha sabe o que quer medir, e é a escolha mais específica. Quem não
-- declarar continua caindo na regra da 0262, sem mudança nenhuma.
--
-- ═══ `agent_id` — quem atende quem responde ═══
--
-- A dívida estava DECLARADA no repo desde antes desta entrega, em
-- `lib/ai/elegibilidade/campanha.ts`: "encaminhar por campanha exige levar o
-- agent_id (…) e o resolve-turn-agent respeitá-lo — não feito nesta entrega".
-- O schema de lá já aceitava `agent_id` e o ignorava.
--
-- Hoje quem atende a resposta de uma campanha é o agente publicado no NÚMERO,
-- ou o roteador dele. Para prospecção isso é errado por construção: o roteiro
-- de quem aborda é outro, e a LIA-2026-01 promete que quem perguntar "de onde
-- veio meu contato?" recebe a resposta na hora — promessa que só se cumpre se
-- QUEM ATENDE souber respondê-la.
--
-- O agente da campanha só assume conversa que NASCE dela (decisão do dono): o
-- cliente antigo que responde a uma reativação continua com quem já o atendia,
-- em vez de ser sequestrado para o roteiro de prospecção.

alter table public.campaigns add column if not exists pipeline_id uuid;
alter table public.campaigns add column if not exists stage_id uuid;
alter table public.campaigns add column if not exists agent_id uuid;

-- Alvos das FKs compostas: índice único (organization_id, id) em cada tabela.
-- Mesmo cuidado da 0262 — criar só se NÃO houver índice único sobre exatamente
-- essas duas colunas, senão toda instalação ganha um segundo índice idêntico,
-- pago em cada escrita.
do $$
declare
  alvo text;
begin
  foreach alvo in array array['crm_pipelines', 'crm_stages', 'ai_agents'] loop
    if not exists (
      select 1
        from pg_index i
        join pg_class t on t.oid = i.indrelid
       where t.relname = alvo
         and t.relnamespace = 'public'::regnamespace
         and i.indisunique
         and i.indnatts = 2
         and (
           select array_agg(a.attname::text order by k.ord)
             from unnest(i.indkey) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
         ) = array['organization_id', 'id']
    ) then
      execute format('create unique index uq_%s_org_id on public.%I (organization_id, id)', alvo, alvo);
    end if;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaigns_pipeline_org_fk') then
    alter table public.campaigns
      add constraint campaigns_pipeline_org_fk
      foreign key (organization_id, pipeline_id)
      references public.crm_pipelines (organization_id, id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_stage_org_fk') then
    alter table public.campaigns
      add constraint campaigns_stage_org_fk
      foreign key (organization_id, stage_id)
      references public.crm_stages (organization_id, id)
      on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'campaigns_agent_org_fk') then
    alter table public.campaigns
      add constraint campaigns_agent_org_fk
      foreign key (organization_id, agent_id)
      references public.ai_agents (organization_id, id)
      on delete set null;
  end if;
end $$;

-- Etapa sem funil seria um card sem coluna: o par anda junto ou não anda.
do $$
begin
  alter table public.campaigns
    add constraint campaigns_etapa_exige_funil
    check (stage_id is null or pipeline_id is not null);
exception when duplicate_object then null; end $$;

comment on column public.campaigns.pipeline_id is
  'Funil em que nasce o card de quem responde. VENCE o funil do número (0262) quando declarado; NULL mantém a regra do número.';
comment on column public.campaigns.agent_id is
  'Quem atende quem responde a esta campanha. Só assume conversa que NASCE da campanha — cliente antigo segue com quem já o atendia. Lido por resolve-turn-agent num degrau acima do roteador.';

-- O degrau novo do roteamento pergunta, a cada turno: esta conversa nasceu de
-- uma campanha com agente? Sem índice, isso seria uma varredura em
-- `campaign_recipients` a cada mensagem recebida da organização inteira.
create index if not exists idx_campaign_recipients_conversa
  on public.campaign_recipients (conversation_id)
  where conversation_id is not null;
