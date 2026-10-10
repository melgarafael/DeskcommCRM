-- 0119 — A DEMANDA como entidade de primeira classe (doutrina cap. 5; spec 17 Fase 4).
--
-- ## O problema, medido
--
-- O propósito do sistema é resolver demandas. A unidade do propósito não
-- existia no modelo: o objeto central era o contato e a conversa.
--
--   * `agent_cases` (7 linhas no banco de referência, **0 com lead_id**) é caso
--     de ESCALADA — nasce só de handoff, é 1:1 com conversa e não conhece o
--     negócio. Bom embrião, não a unidade.
--   * `conversations` termina quando alguém para de escrever; a DEMANDA termina
--     quando é resolvida. A distância entre esses dois eventos é exatamente
--     onde as demandas morrem sem ninguém ver.
--
-- Consequências que isto destrava:
--   1. O índice de atrito passa a ter denominador honesto (spec 17 Fase 4) —
--      até aqui era `agent_cases`, escopo parcial rotulado na tela.
--   2. O invariante 4 ("nenhuma demanda sem próximo passo") passa a ser
--      VERIFICÁVEL: dá para enumerar demandas abertas sem próximo passo.
--   3. Um cliente com três problemas deixa de ter "um estado".
--
-- ## Passo 1 de 4 (cap. 5 §5.6): criar ao lado, sem tirar nada
--
-- Nada é removido nesta migration. `agent_cases` e `conversations` seguem
-- intactos e funcionando; `demandas` nasce apontando para eles.

create table if not exists public.demandas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- SOLICITANTE: quem tem o problema (não necessariamente quem escreveu).
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- Vínculo com o negócio, quando houver. Uma demanda de suporte não tem lead,
  -- e isso é desfecho legítimo — não pendência.
  lead_id uuid references public.crm_leads(id) on delete set null,

  -- Ponteiro para o caso de escalada que originou a demanda, quando houve.
  -- Sem ele, as métricas de toque humano (que vivem em `agent_case_events`)
  -- perderiam a ligação com a demanda ao trocar o denominador do índice.
  agent_case_id uuid references public.agent_cases(id) on delete set null,

  aberta_em timestamptz not null default now(),
  origem text not null default 'inbound'
    check (origem in ('inbound', 'handoff', 'followup', 'manual', 'derivada')),
  assunto text,

  estado text not null default 'aberta'
    check (estado in ('aberta', 'em_atendimento', 'aguardando_cliente', 'resolvida', 'encerrada')),

  -- DONO NUNCA VAZIO (cap. 5 §5.3). Demanda sem dono é a definição operacional
  -- de "vai morrer". Se ninguém assumiu, o dono é a automação — e isso é uma
  -- decisão registrada, não um vazio que ninguém nota.
  dono_kind text not null default 'ia' check (dono_kind in ('ia', 'humano')),
  dono_user_id uuid references auth.users(id) on delete set null,

  -- PRÓXIMO PASSO é CAMPO, não derivação (cap. 5 §5.3): derivado, ele
  -- desapareceria nos casos em que a derivação falha — que são exatamente os
  -- casos em que ele importa. É aqui que o invariante 4 vira verificável.
  proximo_passo text,
  proximo_passo_em timestamptz,
  prazo_em timestamptz,

  -- Desfecho ENUMERADO e terminal. Inclui os que não são vitória: o sistema não
  -- pode ser o único a decidir que uma demanda acabou, senão fecharia por
  -- conveniência (encerrar por inatividade melhora todo número sem melhorar
  -- nada). `expirada_sem_resposta` é desfecho legítimo e RUIM — contável e
  -- vigiado; organização onde ele é zero está mal instrumentada, não saudável.
  desfecho text check (desfecho in (
    'resolvida', 'convertida', 'nao_procede',
    'encerrada_pelo_cliente', 'perdida', 'expirada_sem_resposta'
  )),
  fechada_em timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Desfecho e fechamento andam juntos: um sem o outro é linha meio-fechada,
  -- que nenhuma consulta de "abertas" nem de "encerradas" pegaria.
  constraint demandas_desfecho_coerente
    check ((desfecho is null) = (fechada_em is null)),
  -- Dono humano exige QUEM. `dono_kind='humano'` com user nulo seria dono vazio
  -- com aparência de dono preenchido.
  constraint demandas_dono_humano_tem_user
    check (dono_kind <> 'humano' or dono_user_id is not null)
);

-- Uma demanda atravessa VÁRIOS canais e uma conversa carrega VÁRIAS demandas
-- (cap. 5 §5.4). Resistir a este muitos-para-muitos é a fonte de metade dos
-- problemas de modelagem neste domínio: um-para-um obriga a escolher entre
-- perder o problema que muda de canal e perder o segundo problema da conversa.
create table if not exists public.demanda_conversas (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  demanda_id uuid not null references public.demandas(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  vinculada_em timestamptz not null default now(),
  primary key (demanda_id, conversation_id)
);

create index if not exists idx_demandas_org_abertas
  on public.demandas (organization_id, aberta_em)
  where fechada_em is null;
create index if not exists idx_demandas_org_fechadas
  on public.demandas (organization_id, fechada_em)
  where fechada_em is not null;
create index if not exists idx_demandas_caso
  on public.demandas (organization_id, agent_case_id)
  where agent_case_id is not null;
create index if not exists idx_demandas_contato
  on public.demandas (organization_id, contact_id);
-- O invariante 4 em forma de índice: demanda aberta SEM próximo passo é o
-- vazamento que a doutrina proíbe, e precisa ser barato de enumerar.
create index if not exists idx_demandas_sem_proximo_passo
  on public.demandas (organization_id, aberta_em)
  where fechada_em is null and proximo_passo is null;
create index if not exists idx_demanda_conversas_conv
  on public.demanda_conversas (organization_id, conversation_id);

alter table public.demandas enable row level security;
alter table public.demanda_conversas enable row level security;

drop policy if exists tenant_isolation_demandas_all on public.demandas;
create policy tenant_isolation_demandas_all on public.demandas
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

drop policy if exists tenant_isolation_demanda_conversas_all on public.demanda_conversas;
create policy tenant_isolation_demanda_conversas_all on public.demanda_conversas
  for all
  using (organization_id in (select * from public.fn_user_org_ids()))
  with check (organization_id in (select * from public.fn_user_org_ids()));

-- ---------------------------------------------------------------------------
-- Passo 2 de 4: derivar o passado por REGRA EXPLÍCITA, nunca por adivinhação.
--
-- A regra fica escrita porque histórico derivado por regra é honesto e
-- histórico derivado por heurística contamina toda comparação futura — e
-- ninguém vai lembrar disso daqui a seis meses, comparando dois trimestres.
--
--   R1. Todo `agent_cases` vira uma demanda (origem 'handoff'). O mapeamento de
--       status é 1:1 e sem interpretação.
--   R2. Toda conversa SEM agent_case vira uma demanda (origem 'derivada'),
--       porque houve uma pessoa com um assunto ali. `assunto` fica NULO — não
--       inventamos o que a conversa tratava.
--
-- Idempotente por `where not exists`: re-aplicar não duplica.
-- ---------------------------------------------------------------------------

-- R1 — a partir dos casos de escalada.
insert into public.demandas
  (organization_id, contact_id, lead_id, agent_case_id, aberta_em, origem, assunto,
   estado, dono_kind, desfecho, fechada_em)
select
  c.organization_id,
  cv.contact_id,
  c.lead_id,
  c.id,
  c.opened_at,
  'handoff',
  c.title,
  case c.status
    when 'awaiting_human' then 'em_atendimento'
    when 'awaiting_lead'  then 'aguardando_cliente'
    when 'resolved'       then 'resolvida'
    when 'escalated'      then 'em_atendimento'
    when 'cancelled'      then 'encerrada'
    else 'aberta'
  end,
  'ia',
  case c.status
    when 'resolved'  then 'resolvida'
    when 'cancelled' then 'nao_procede'
    else null
  end,
  case when c.status in ('resolved', 'cancelled') then c.closed_at else null end
  from public.agent_cases c
  join public.conversations cv on cv.id = c.conversation_id
 where not exists (
   select 1 from public.demandas d
    where d.organization_id = c.organization_id
      and d.contact_id = cv.contact_id
      and d.origem = 'handoff'
      and d.aberta_em = c.opened_at
 );

-- Vínculo N:N das demandas derivadas de caso.
insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
select d.organization_id, d.id, c.conversation_id
  from public.demandas d
  join public.agent_cases c on c.id = d.agent_case_id
 where d.agent_case_id is not null
   and not exists (
     select 1 from public.demanda_conversas dc
      where dc.demanda_id = d.id and dc.conversation_id = c.conversation_id
   );

-- R2 — conversas que nunca escalaram também são demandas.
insert into public.demandas
  (organization_id, contact_id, aberta_em, origem, estado, dono_kind, desfecho, fechada_em)
select
  cv.organization_id,
  cv.contact_id,
  cv.created_at,
  'derivada',
  case cv.status when 'resolved' then 'resolvida' when 'closed' then 'encerrada' else 'aberta' end,
  'ia',
  case when cv.status in ('resolved', 'closed') then 'resolvida' else null end,
  case when cv.status in ('resolved', 'closed') then cv.status_changed_at else null end
  from public.conversations cv
 where not exists (
   select 1 from public.agent_cases c where c.conversation_id = cv.id
 )
   and not exists (
   select 1 from public.demandas d
    where d.organization_id = cv.organization_id
      and d.contact_id = cv.contact_id
      and d.origem = 'derivada'
      and d.aberta_em = cv.created_at
 );

insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
select d.organization_id, d.id, cv.id
  from public.demandas d
  join public.conversations cv
    on cv.organization_id = d.organization_id
   and cv.contact_id = d.contact_id
   and cv.created_at = d.aberta_em
 where d.origem = 'derivada'
   and not exists (
     select 1 from public.demanda_conversas dc
      where dc.demanda_id = d.id and dc.conversation_id = cv.id
   );

comment on table public.demandas is
  'A unidade do PROPÓSITO (doutrina cap. 5): uma coisa a ser resolvida. '
  'Contato é quem pede; conversa é por onde se fala; demanda é o que precisa '
  'acabar. Dono nunca vazio; próximo passo é campo, não derivação.';
