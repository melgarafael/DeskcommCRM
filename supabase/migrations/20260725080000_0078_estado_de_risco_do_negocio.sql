-- 0078 — "esfriando" deixa de ser adjetivo calculado e vira ESTADO do negócio
--
-- O QUE ESTAVA ERRADO: `classifyRisk` é função pura recalculada a cada leitura,
-- e os únicos chamadores são rotas de LEITURA. Nenhum worker, nenhum emissor.
-- Consequência medida: "esfriando" não existia até alguém abrir a tela, não
-- tinha tipo de atividade (o vocabulário não sabia dizer "esfriou" nem
-- "voltou"), e — o pior — não era RETIDO: não havia como responder "há quanto
-- tempo está esfriando" nem "quantas vezes já esfriou e voltou".
--
-- A ironia que motivou a wave: o cabeçalho de `lib/leads/risk-radar.ts` declara
-- ser o desilhamento C1 da doutrina do sistema vivo — "uma demanda que esfriou
-- e não tem próximo passo garantido está morrendo sem ninguém ver; o radar a
-- torna visível". Mas tornar visível numa tela que ninguém é obrigado a abrir
-- não é mecanismo anti-morte: é a mesma morte, com testemunha opcional.
--
-- ⚠️ POR QUE FORA DE `crm_leads` — os dois motivos são os MESMOS da 0075 e
-- valem palavra por palavra aqui; leia aquele cabeçalho antes de "simplificar"
-- isto para dentro do lead:
--   1. o PULSO QUE MENTE — o board assina `crm_leads`; uma varredura de risco
--      em lote faria dezenas de cards piscarem sem novidade nenhuma;
--   2. o 409 FANTASMA — `trg_crm_leads_updated_at` invalida a trava otimista do
--      arrasto em voo, e o usuário recebe "alguém editou este lead" quando
--      ninguém editou.
--
-- ⚠️ MAS ESTA TABELA FICA **DENTRO** DA PUBLICAÇÃO DE REALTIME, ao contrário da
-- `crm_lead_scores`. Isso NÃO contradiz a 0075 — é a mesma regra aplicada:
-- "silêncio para telemetria, pulso para mudança de estado". Score é telemetria
-- (número que se move sozinho o tempo todo); risco é transição discreta e rara
-- que EXIGE ação humana. É por aqui que a borda de aviso aparece sem reload,
-- sem tocar o lead — e é justamente não tocar o lead que preserva 1 e 2.
--
-- A CONTRAPARTIDA, que vive no escritor e não dá para o banco garantir: só
-- escreva quando o BUCKET MUDAR. Um `update` que só refresca `detected_at`
-- publicaria evento de realtime sem mudança de estado, e o board voltaria a
-- piscar à toa — o defeito que esta separação toda existe para impedir.

create table if not exists public.crm_lead_risk_states (
  lead_id uuid primary key references public.crm_leads(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bucket text not null,
  -- QUANDO O NEGÓCIO ENTROU NESTE ESTADO, que não é quando o sistema percebeu.
  -- A distinção é o que torna o acervo honesto: os 48 negócios já frios no dia
  -- da estreia entram com `since` no passado (o instante em que de fato
  -- esfriaram) e `detected_at` em now. Sem os dois campos, o histórico diria
  -- que todos esfriaram no mesmo minuto — e diria isso para sempre.
  since timestamptz not null,
  detected_at timestamptz not null default now(),
  -- A janela do estágio usada na decisão, gravada JUNTO. Sem ela, mudar
  -- `expected_duration_hours` reescreve retroativamente o significado de todo
  -- estado já gravado, e ninguém consegue explicar por que aquele negócio
  -- esfriou "às 24h" se hoje o estágio diz 72h.
  cold_hours numeric not null,
  updated_at timestamptz not null default now()
);

comment on table public.crm_lead_risk_states is
  'Estado de risco por negócio (wave 7 — o ciclo). FORA de crm_leads pelos motivos da 0075 (pulso que mente, 409 fantasma), mas DENTRO da publicação supabase_realtime, ao contrário de crm_lead_scores: risco é mudança de estado, não telemetria. O escritor só grava quando o bucket muda.';

alter table public.crm_lead_risk_states
  drop constraint if exists crm_lead_risk_states_bucket_check;
alter table public.crm_lead_risk_states
  add constraint crm_lead_risk_states_bucket_check check (
    bucket = any (array['em_dia', 'em_voo', 'em_risco', 'critico']::text[])
  );

-- Estado não começa no futuro. Trava o erro de gravar `since = now + janela`
-- (o instante em que VAI esfriar) em vez de `last_activity_at + janela`.
alter table public.crm_lead_risk_states
  drop constraint if exists crm_lead_risk_states_since_no_passado;
alter table public.crm_lead_risk_states
  add constraint crm_lead_risk_states_since_no_passado check (since <= detected_at);

alter table public.crm_lead_risk_states
  drop constraint if exists crm_lead_risk_states_cold_hours_positivo;
alter table public.crm_lead_risk_states
  add constraint crm_lead_risk_states_cold_hours_positivo check (cold_hours > 0);

alter table public.crm_lead_risk_states enable row level security;

drop policy if exists tenant_isolation_crm_lead_risk_states_all on public.crm_lead_risk_states;
create policy tenant_isolation_crm_lead_risk_states_all on public.crm_lead_risk_states
  for all
  using (organization_id in (select fn_user_org_ids()))
  with check (organization_id in (select fn_user_org_ids()));

-- O radar lê "quem está em risco nesta org", nesta ordem.
create index if not exists idx_crm_lead_risk_states_org_bucket
  on public.crm_lead_risk_states (organization_id, bucket, since);

-- DENTRO da publicação — ver o cabeçalho. Idempotente: só adiciona se faltar.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'crm_lead_risk_states'
  ) then
    execute 'alter publication supabase_realtime add table public.crm_lead_risk_states';
  end if;
end $$;
