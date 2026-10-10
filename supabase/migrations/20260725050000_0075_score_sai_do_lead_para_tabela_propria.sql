-- 0075 — o score sai de `crm_leads` e ganha tabela própria
--
-- ⚠️ NÃO TRAGA ESTES CAMPOS DE VOLTA PARA `crm_leads`. Uma tabela 1:1 é a coisa
-- que a próxima pessoa mais quer "simplificar" para dentro do lead, e a
-- simplificação PARECE limpeza. Ela reintroduz, em silêncio, dois defeitos com
-- nome — e nenhum dos dois aparece em teste unitário:
--
--   1. O PULSO QUE MENTE. O board assina `crm_leads` por realtime. Score dentro
--      do lead faz cada recálculo em segundo plano pintar o card como se algo
--      tivesse acontecido para o usuário. Recalcular 20 leads faria 20 cards
--      pulsarem sem novidade nenhuma — e sinal que pisca à toa é sinal em que o
--      usuário para de olhar.
--
--   2. O 409 FANTASMA, que é o pior dos dois. `crm_leads` tem
--      `trg_crm_leads_updated_at` BEFORE UPDATE FOR EACH ROW, que bumpa
--      `updated_at` em QUALQUER escrita, e `app/api/v1/leads/[id]/move` usa
--      trava otimista (`.eq('updated_at', expected_updated_at)`). Com o score na
--      mesma linha, um recálculo em background INVALIDA O ARRASTO EM VOO: o
--      usuário solta o card e recebe "alguém editou este lead" — e ninguém
--      editou. Ele não conclui "o sistema recalculou"; conclui "o sistema é
--      instável". Trabalho humano recusado por um evento invisível, sem pista
--      de causa.
--
-- A composição fica certa pelo caminho que já existe, sem regra nova: recálculo
-- comum não toca `crm_leads`, então não pulsa nem invalida trava (telemetria);
-- travessia de faixa EMITE ATIVIDADE, o `trg_update_last_activity_at` toca o
-- lead, e aí o board pulsa — pelo motivo certo. Silêncio para telemetria, pulso
-- para mudança de estado.
--
-- OS SEIS CAMPOS ANDAM JUNTOS. O CHECK de coerência amarra `band` a `score` na
-- MESMA LINHA, e CHECK não atravessa tabela. Se um dia parecer atraente deixar
-- "só a faixa" no lead para o card não precisar do join, a resposta já está
-- decidida: aí a divergência entre faixa e score volta a ser IMPROVÁVEL em vez
-- de IMPOSSÍVEL, que foi exatamente o que se comprou com o CHECK.

create table if not exists public.crm_lead_scores (
  lead_id uuid primary key references public.crm_leads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ai_probability numeric(5, 2),
  ai_probability_reason text,
  ai_probability_evidence jsonb not null default '{}'::jsonb,
  ai_probability_at timestamptz,
  ai_probability_band text,
  ai_probability_band_since timestamptz,
  updated_at timestamptz not null default now()
);

-- `primary key (lead_id)` já garante o 1:1 — um lead tem no máximo uma linha de
-- score. FK com `on delete cascade`: score é sobre o negócio, e sem o negócio
-- não significa nada (não é histórico, é estado corrente).

comment on table public.crm_lead_scores is
  'Score de probabilidade por lead, FORA de crm_leads de propósito. Ver o cabeçalho da migration 0075: trazer estes campos de volta reintroduz o pulso que mente (board assina crm_leads) e o 409 fantasma (trava otimista do move + trigger de updated_at). Fica FORA da publicação supabase_realtime — recálculo é telemetria e não deve pintar card; quem pinta é a atividade emitida na travessia de faixa.';

-- ---- migra o que existir (clones que já aplicaram a 0074) ----
-- SQL DINÂMICO de propósito: numa instalação NOVA as colunas nunca existiram em
-- `crm_leads`, e o Postgres faz o parse do comando ANTES de avaliar qualquer
-- guarda — `where exists (select from information_schema...)` não salva, porque
-- o erro é de parse, não de execução. Só `execute` adia a resolução do nome.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'crm_leads'
       and column_name = 'ai_probability'
  ) then
    execute $mig$
      insert into public.crm_lead_scores (
        lead_id, organization_id, ai_probability, ai_probability_reason,
        ai_probability_evidence, ai_probability_at, ai_probability_band,
        ai_probability_band_since
      )
      select l.id, l.organization_id, l.ai_probability, l.ai_probability_reason,
             coalesce(l.ai_probability_evidence, '{}'::jsonb), l.ai_probability_at,
             l.ai_probability_band, l.ai_probability_band_since
        from public.crm_leads l
       where l.ai_probability is not null
      on conflict (lead_id) do nothing
    $mig$;
  end if;
end $$;

alter table public.crm_leads
  drop constraint if exists crm_leads_score_needs_reason,
  drop constraint if exists crm_leads_score_range,
  drop constraint if exists crm_leads_score_band_check,
  drop constraint if exists crm_leads_score_band_coherence;

alter table public.crm_leads
  drop column if exists ai_probability,
  drop column if exists ai_probability_reason,
  drop column if exists ai_probability_evidence,
  drop column if exists ai_probability_at,
  drop column if exists ai_probability_band,
  drop column if exists ai_probability_band_since;

-- ---- as mesmas garantias, agora na tabela certa ----
alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_needs_reason;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_needs_reason check (
    ai_probability is null
    or (
      ai_probability_reason is not null
      and btrim(ai_probability_reason) <> ''
      and coalesce(jsonb_array_length(ai_probability_evidence -> 'activity_ids'), 0)
        + coalesce(jsonb_array_length(ai_probability_evidence -> 'message_ids'), 0)
        + coalesce(jsonb_array_length(ai_probability_evidence -> 'checkpoint_ids'), 0) > 0
    )
  );

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_range;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_range check (
    ai_probability is null or (ai_probability >= 0 and ai_probability <= 100)
  );

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_band_check;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_band_check check (
    ai_probability_band is null
    or ai_probability_band = any (array['frio', 'morno', 'quente']::text[])
  );

alter table public.crm_lead_scores
  drop constraint if exists crm_lead_scores_band_coherence;

alter table public.crm_lead_scores
  add constraint crm_lead_scores_band_coherence check (
    ai_probability_band is null
    or ai_probability is null
    or (ai_probability_band = 'quente' and ai_probability >= 65)
    or (ai_probability_band = 'morno' and ai_probability >= 35 and ai_probability <= 75)
    or (ai_probability_band = 'frio' and ai_probability <= 45)
  );

comment on column public.crm_lead_scores.ai_probability is
  'Probabilidade 0-100 por FÓRMULA determinística sobre sinais que já existem — nunca chamada de modelo. Com fórmula, o reason é DERIVADO do cálculo e "número sem porquê" é impossível por construção; com modelo, a frase é gerada ao lado do número e a lei só pareceria cumprida. null = sinal insuficiente, e é estado legítimo: nunca zero.';

comment on column public.crm_lead_scores.ai_probability_reason is
  'O PORQUÊ em português, obrigatório por constraint quando há score. Existe para o humano poder DISCORDAR: sem razão citável o número é opinião sem apelação.';

comment on column public.crm_lead_scores.ai_probability_evidence is
  'O QUE SUSTENTA (N referências): activity_ids→crm_lead_activities, message_ids→messages, checkpoint_ids→lead_checkpoints. A constraint exige pelo menos uma — razão sem referência é adjetivo.';

comment on column public.crm_lead_scores.ai_probability_band is
  'Faixa exibida. Persistida porque histerese precisa da faixa anterior; o CHECK de coerência torna divergir do score IMPOSSÍVEL de gravar, não só improvável. Cortes em FAIXA_LIMITES (lib/kanban/score-band.ts), fonte única do CHECK, do emissor e da UI.';

-- ---- tenancy ----
alter table public.crm_lead_scores enable row level security;

drop policy if exists tenant_isolation_crm_lead_scores_all on public.crm_lead_scores;
create policy tenant_isolation_crm_lead_scores_all on public.crm_lead_scores
  for all
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

create index if not exists idx_crm_lead_scores_org_band
  on public.crm_lead_scores (organization_id, ai_probability_band);

-- FORA da publicação de realtime — é o ponto inteiro desta migration. Remover
-- é defensivo: se um clone tiver a tabela publicada por engano, isto corrige.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'crm_lead_scores'
  ) then
    execute 'alter publication supabase_realtime drop table public.crm_lead_scores';
  end if;
end $$;
