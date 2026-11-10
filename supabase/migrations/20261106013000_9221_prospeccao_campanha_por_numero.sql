-- manifest: **Uma campanha de prospecção em andamento por NÚMERO, não por organização (#3896):** promove `prospecting_campaigns.channel_session_id` a coluna (com backfill de `config->>'channel_session_id'`), pausa a campanha `running` cuja conexão não existe mais nesta organização (inexistente, arquivada ou órfã) e troca o índice único parcial `prospecting_one_running_org` por `prospecting_one_running_canal` em `(organization_id, channel_session_id)`. A chave da trava passa a ser o número; a regra de uma campanha por número continua. Idempotente (bloco DO); espelho no fim do apêndice do `supabase/baseline.sql`.
-- ============================================================================
-- 9221 — UMA CAMPANHA DE PROSPECÇÃO EM ANDAMENTO POR NÚMERO (issue #3896).
--
-- A régua anterior era por ORGANIZAÇÃO: três conexões conectadas dividiam uma
-- campanha, e o volume diário ficava o de um número só. Cada número tem agente
-- publicado, região e AQUECIMENTO próprios — e é o aquecimento que exige que a
-- trava continue existindo, agora com o número como sujeito: duas campanhas no
-- MESMO número somariam no mesmo teto de primeiras abordagens, que é o que a
-- plataforma pune com banimento.
--
-- Por que COLUNA e não índice por expressão sobre `config->>'channel_session_id'`:
--   1. dependência de caminho dentro de jsonb (anti-padrão 6 do CLAUDE.md);
--   2. uma linha `running` com `config` nulo teria chave NULL, e NULL não
--      colide em índice único — a linha escaparia da trava;
--   3. o worker precisa contar tentativas POR NÚMERO (join com a campanha do
--      candidato) a cada rodada, e coluna indexável resolve isso sem expressão.
--
-- Sem FK composta para `channel_sessions(organization_id, id)`: a linha do
-- canal é ARQUIVADA, nunca apagada (por isso `channel_archived` existe), mas
-- uma FK `no action` passaria a recusar a limpeza de uma conexão antiga por
-- causa de campanha CONCLUÍDA que ainda aponta para ela. A integridade fica com
-- `validateConfig` (resolve a conexão por organização, recusa arquivada e de
-- outra organização) e com a pausa abaixo, que limpa o legado.
-- ============================================================================

do $$
declare
  pausadas integer;
begin
  -- 1. A COLUNA. Nula em rascunho nunca iniciado (`config` nulo) — quem inicia
  --    grava a coluna e o `config` juntos (`activateCampaign`/`resume`).
  alter table public.prospecting_campaigns
    add column if not exists channel_session_id uuid;

  -- 2. BACKFILL do jsonb, que é onde o número morava até aqui. A guarda de
  --    formato evita que um `config` torto (texto qualquer no campo) derrube a
  --    migration inteira: linha que não é uuid fica nula e cai no passo 3.
  --    `~*` aceita maiúsculas, como o uuid do Postgres aceita.
  update public.prospecting_campaigns
     set channel_session_id = trim(config->>'channel_session_id')::uuid
   where channel_session_id is null
     and config is not null
     and trim(config->>'channel_session_id') ~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  -- 3. CAMPANHA RODANDO SEM CONEXÃO VÁLIDA NÃO PODE CONTINUAR RODANDO.
  --    Ela não consegue enviar (o worker recusa em `validateConfig`) e, com a
  --    coluna nula, escaparia da trava do índice — o estado impossível que a
  --    coluna existe para fechar. Pausar deixa o motivo no cartão e devolve o
  --    comando a quem opera: nada é enviado, nada é apagado.
  update public.prospecting_campaigns pc
     set status = 'paused',
         error = 'Pausada ao migrar: esta campanha não tinha uma conexão de WhatsApp válida nesta organização. Escolha uma conexão e inicie de novo.',
         channel_down_since = null,
         updated_at = now()
   where pc.status = 'running'
     and (pc.channel_session_id is null
          or not exists (select 1
                           from public.channel_sessions s
                          where s.organization_id = pc.organization_id
                            and s.id = pc.channel_session_id
                            and s.archived_at is null));
  get diagnostics pausadas = row_count;
  if pausadas > 0 then
    raise notice '9221: % campanha(s) running pausada(s) por falta de conexão válida', pausadas;
  end if;

  -- 4. O ESTADO IMPOSSÍVEL VIRA CONSTRAINT. Sem isto, uma escrita fora da rota
  --    (import, correção manual) deixa `running` sem número e a linha escapa do
  --    índice único parcial — a trava existiria no papel e não no banco.
  if not exists (
    select 1 from pg_constraint
     where conname = 'prospecting_campaigns_running_tem_canal'
       and conrelid = 'public.prospecting_campaigns'::regclass
  ) then
    alter table public.prospecting_campaigns
      add constraint prospecting_campaigns_running_tem_canal
      check (status <> 'running' or channel_session_id is not null) not valid;
    alter table public.prospecting_campaigns
      validate constraint prospecting_campaigns_running_tem_canal;
  end if;

  -- 5. A TROCA DA CHAVE. O índice antigo é por ORGANIZAÇÃO e é ele que produzia
  --    o 409 "Pause a campanha atual" no banco (23505, que virava 500 genérico).
  drop index if exists public.prospecting_one_running_org;
  create unique index if not exists prospecting_one_running_canal
    on public.prospecting_campaigns(organization_id, channel_session_id)
    where status = 'running';

  comment on column public.prospecting_campaigns.channel_session_id is
    'Número de WhatsApp (channel_sessions.id) por onde esta campanha dispara. Chave da trava "uma campanha running por número" (índice prospecting_one_running_canal, #3896). Nulo só em rascunho nunca iniciado; quem inicia grava junto com config.channel_session_id.';
end $$;
