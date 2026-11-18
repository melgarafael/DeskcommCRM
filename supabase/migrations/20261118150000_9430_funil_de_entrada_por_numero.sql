-- manifest: **Cada número (conexão) pode escolher o funil e a etapa onde a conversa nova vira negócio.** Duas colunas em `channel_sessions` — `entry_pipeline_id` e `entry_stage_id`, ambas nulas por padrão e com chave estrangeira (`on delete set null`) para `crm_pipelines` e `crm_stages`. Nulas = o comportamento de sempre (o funil padrão da organização). Quem grava é `PATCH /api/v1/channel-sessions/[id]/entrada`, que confere que funil e etapa são da MESMA organização do número; quem aplica é `lib/leads/nascimento-do-lead.ts`, que confere de novo na hora de usar e cai no funil padrão quando a escolha não serve mais (funil arquivado, etapa arquivada ou de ganho/perda). Antes disto, o funil de entrada era um só por organização (`crm_pipelines.is_default`) e não havia como mandar quem escreve para o número de atacado para o funil de atacado — automação também não fazia, porque `create_or_move_lead` recusa trocar de funil a partir de `message.received` e uma regra não dispara outra.

-- 9430 — funil de entrada por número.
--
-- Idempotente: `add column if not exists` e índices `if not exists`. Não toca
-- em dado nenhum — toda conexão existente fica com as duas colunas nulas, que é
-- exatamente o comportamento de antes.
--
-- Por que FK e não `metadata` jsonb: o destino é um ponteiro para outra tabela
-- (doutrina DIRC, "Referenciar"), e ponteiro sem FK vira inferência por nome
-- (anti-pattern 4). A FK não conhece organização — a conferência de tenancy é
-- do handler que grava e do nascimento que lê.

alter table public.channel_sessions
  add column if not exists entry_pipeline_id uuid
    references public.crm_pipelines(id) on delete set null;

alter table public.channel_sessions
  add column if not exists entry_stage_id uuid
    references public.crm_stages(id) on delete set null;

comment on column public.channel_sessions.entry_pipeline_id is
  'Funil onde a conversa nova DESTE número vira negócio. Nulo = funil padrão da organização (crm_pipelines.is_default). Aplicado por lib/leads/nascimento-do-lead.ts (migration 9430).';
comment on column public.channel_sessions.entry_stage_id is
  'Etapa de entrada no funil escolhido para este número. Nula = a etapa de entrada do próprio funil. Ignorada sem entry_pipeline_id (migration 9430).';

create index if not exists idx_channel_sessions_entry_pipeline
  on public.channel_sessions (entry_pipeline_id) where entry_pipeline_id is not null;
create index if not exists idx_channel_sessions_entry_stage
  on public.channel_sessions (entry_stage_id) where entry_stage_id is not null;

notify pgrst, 'reload schema';
