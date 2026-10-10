-- ============================================================================
-- 0174 — O HISTÓRICO DE QUEM CHEGOU PELO FORMULÁRIO.
--
-- Quem publica uma landing page precisa responder três perguntas depois:
-- "chegou alguém?", "com que dados?" e "de onde?". Hoje o produto não responde
-- nenhuma delas de forma durável — e o motivo é que a única coisa que existe é
-- o ARQUIVO FORENSE (`webhook_events_log`), que é outra coisa.
--
-- ─── Por que não reusar `webhook_events_log` ───────────────────────────────
--
-- Porque ele é, por desenho, DESCARTÁVEL, e a migration 0163 tornou isso
-- explícito: o cron `webhook-log-retention` (a cada 5 min) **zera**
-- `raw_body`, `payload_parsed` e `headers` depois de
-- `WEBHOOK_LOG_BODY_RETENTION_DAYS` (7 por padrão) e **apaga a linha inteira**
-- depois de `WEBHOOK_LOG_ROW_RETENTION_DAYS` (90). Isso foi a coisa certa a
-- fazer — numa instalação real ele era 468 MB de um banco de 545 MB, 86% do
-- total, contra 3,2 MB de `messages` — mas transforma qualquer histórico
-- construído sobre ele numa tela que MENTE a partir do sétimo dia: os campos
-- viram `null` e nada na UI distingue "o formulário veio vazio" de "o corpo foi
-- descartado ontem".
--
-- Um arquivo de depuração de webhook e um histórico de negócio têm ciclos de
-- vida opostos: o primeiro precisa sumir rápido (é grande, é bruto, é de todos
-- os provedores), o segundo precisa durar (é pequeno, é curado, é o registro de
-- que aquele contato existiu e de onde ele veio). Empilhar os dois na mesma
-- tabela é o que obriga a escolher entre disco e memória do negócio.
--
-- ─── O que esta tabela guarda que o arquivo NÃO guardava ───────────────────
--
--  * O IP de origem, em coluna própria e tipada (`inet`). No arquivo ele só
--    existia solto dentro do jsonb `headers` — e `headers` é exatamente uma das
--    três colunas que a poda zera em D+7.
--  * O DESFECHO. O arquivo registra "chegou um POST"; ele não sabe dizer se
--    aquilo virou lead, se caiu na deduplicação por `external_id`, ou se foi
--    recusado por não ter nenhum campo aproveitável. Hoje um formulário mal
--    mapeado devolve 400 ao site do cliente e não deixa NENHUM rastro que a
--    pessoa consiga ver na tela — ela só sabe que "não chegou nada".
--  * O nome da fonte NO MOMENTO da captação. A fonte pode ser renomeada ou
--    excluída; o histórico responde de onde o contato VEIO, não de onde ele
--    viria hoje. Por isso a FK é `on delete set null` e o nome é uma cópia
--    deliberada — é o caso em que duplicar é a resposta certa da DIRC, porque
--    o valor é um fato datado, não uma referência.
--
-- ─── Sobre gravar o IP ─────────────────────────────────────────────────────
--
-- `x-forwarded-for` é forjável por quem faz o POST, e esta coluna NÃO é
-- material de segurança: nada no produto decide nada com base nela. Ela existe
-- para o dono do negócio olhar e reconhecer padrão — "esses 40 leads vieram
-- todos do mesmo IP em 3 minutos". No stack padrão do kit o header chega de
-- verdade (o `app` não publica porta; quem publica é o Caddy, que faz
-- `reverse_proxy app:3000` e seta o header). Numa instalação sem proxy nenhum
-- ele não chega, e a coluna fica NULL — que é a resposta honesta, e o motivo de
-- ela ser NULLABLE em vez de ter uma sentinela do tipo '0.0.0.0'.
--
-- ─── Retenção ──────────────────────────────────────────────────────────────
--
-- Uma linha por formulário preenchido, ~1 kB. Um cliente de 300 leads/dia gera
-- ~110 MB/ano — não é o arquivo bruto (23 MB/DIA, medido), mas também não é
-- nada num plano de 500 MB. A poda é do MESMO cron do arquivo
-- (`webhook-log-retention`), com janela própria e generosa
-- (`LEAD_CAPTURE_RETENTION_DAYS`, 365 por padrão, piso de 30 no código).
--
-- ─── RLS: por que `manager`, e não a org inteira ───────────────────────────
--
-- `fields` carrega o formulário COMO A PESSOA PREENCHEU — nome, telefone,
-- e-mail e o que mais o site mandar. A policy de `webhook_events_log` é
-- org-flat sem gate de papel, o que significa que hoje qualquer `viewer` lê
-- essa PII direto pelo PostgREST com a chave anônima + o JWT dele, mesmo com a
-- rota HTTP exigindo `manager`. Não repetir o buraco: aqui o SELECT exige
-- `manager`, o mesmo papel que a tela de Webhooks já exige.
--
-- Não há policy de INSERT/UPDATE/DELETE de propósito: só o service role
-- escreve (a rota pública de captação), e ele bypassa RLS.
-- ============================================================================

create table if not exists public.webhook_lead_captures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `set null` e não cascade: excluir a fonte para a captação FUTURA; o que já
  -- entrou continua sendo história. `source_name` é a cópia datada.
  webhook_source_id uuid references public.webhook_sources(id) on delete set null,
  source_name text not null,

  -- Para onde o contato foi. NULL quando o desfecho não gerou lead (recusado),
  -- ou quando o lead foi apagado depois.
  lead_id uuid references public.crm_leads(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,

  outcome text not null
    check (outcome in ('criado', 'duplicado', 'recusado')),
  -- Só quando `outcome = 'recusado'`: o que impediu. Vocabulário no TypeScript
  -- (`lib/webhooks/captacao.ts`), sem CHECK — motivo novo não pode quebrar o
  -- `update.sh` de um clone com linhas antigas.
  reject_reason text,

  -- O que o mapeamento entendeu de cada campo canônico. Coluna própria (e não
  -- só dentro de `fields`) porque é por eles que a tela procura e ordena.
  captured_name text,
  captured_phone text,
  captured_email text,
  -- TODO o resto do formulário, como chegou. É PII.
  fields jsonb not null default '{}'::jsonb,
  -- utm_* separados: é a pergunta "de qual campanha veio", e ela tem tela.
  utm jsonb not null default '{}'::jsonb,

  remote_ip inet,
  user_agent text,
  -- `Origin`/`Referer`: a PÁGINA que hospedava o formulário.
  origin text,

  request_id uuid,
  received_at timestamptz not null default now()
);

-- A consulta da tela: histórico da organização, mais recente primeiro.
-- Keyset por (received_at desc, id desc) — o mesmo par que o cursor usa, senão
-- duas captações no mesmo milissegundo pulam ou repetem entre páginas.
create index if not exists webhook_lead_captures_org_recebido_idx
  on public.webhook_lead_captures (organization_id, received_at desc, id desc);

-- O filtro "só desta fonte", que o detalhe da fonte abre.
create index if not exists webhook_lead_captures_fonte_idx
  on public.webhook_lead_captures (webhook_source_id, received_at desc)
  where webhook_source_id is not null;

-- "Este lead veio de qual formulário?" — a volta, que a timeline do lead usa.
create index if not exists webhook_lead_captures_lead_idx
  on public.webhook_lead_captures (lead_id)
  where lead_id is not null;

-- A poda: varre pela ponta mais velha, sem tocar em organização nenhuma.
create index if not exists webhook_lead_captures_poda_idx
  on public.webhook_lead_captures (received_at);

comment on table public.webhook_lead_captures is
  'Histórico DURÁVEL de leads captados por formulário/webhook: o que chegou, quando, de onde (IP, página, UTM) e no que deu. '
  'Distinto de webhook_events_log, que é arquivo forense e é PODADO (corpo em D+7, linha em D+90).';
comment on column public.webhook_lead_captures.remote_ip is
  'IP de origem do POST, lido de x-forwarded-for/x-real-ip. Informativo — forjável, nada no produto decide com base nele. NULL = não havia proxy à frente.';
comment on column public.webhook_lead_captures.outcome is
  'criado = virou lead novo; duplicado = mesmo external_id já capturado antes (retry da ferramenta); recusado = não entrou (reject_reason diz por quê).';
comment on column public.webhook_lead_captures.source_name is
  'Nome da fonte NO MOMENTO da captação. Cópia deliberada: a fonte pode ser renomeada ou excluída, e o histórico responde de onde o contato veio.';

alter table public.webhook_lead_captures enable row level security;

drop policy if exists "webhook_lead_captures_manager_read" on public.webhook_lead_captures;
create policy "webhook_lead_captures_manager_read" on public.webhook_lead_captures
  for select using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- ─── LGPD: o cascade de anonimização precisa alcançar esta tabela ──────────
--
-- `fn_lgpd_cascade_redact_contact` tem 8 passos e nenhum tocava webhook nenhum
-- — o que era coerente enquanto o único registro de webhook era podado sozinho
-- em 90 dias. Uma tabela que DURA muda isso: sem este passo, o nome e o
-- telefone de quem pediu anonimização continuariam legíveis aqui para sempre,
-- e o produto estaria dizendo "anonimizado" enquanto guarda o formulário
-- original.
--
-- `fields` e `utm` viram objeto vazio em vez de sumirem: a LINHA permanece
-- (ela é a prova de que a captação aconteceu, e a data/origem não são dados
-- pessoais do titular no sentido que a anonimização ataca), o CONTEÚDO é que
-- sai. Mesma escolha dos outros 8 passos: anonimizar, não apagar.
--
-- ─── Por que um TRIGGER, e não um 9º passo dentro do cascade ───────────────
--
-- `fn_lgpd_cascade_redact_contact` tem 180 linhas. Acrescentar um passo exigiria
-- reescrevê-la INTEIRA no apêndice do baseline (é `create or replace`), e a
-- partir daí existiriam duas cópias da mesma função — a do dump e a do
-- apêndice — que divergem no primeiro conserto que alguém fizer na de cima.
--
-- O gancho é a transição `is_anonymized false → true` na própria `contacts`,
-- que é o ÚLTIMO fato da anonimização e roda na MESMA transação do cascade. E
-- ele alcança mais que o 9º passo alcançaria: qualquer caminho que anonimize um
-- contato — hoje só a RPC, amanhã um script de operação — passa por este UPDATE.
create or replace function public.fn_redigir_captacoes_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.webhook_lead_captures
     set captured_name = null,
         captured_phone = null,
         captured_email = null,
         fields = '{}'::jsonb,
         utm = '{}'::jsonb,
         remote_ip = null,
         user_agent = null
   where organization_id = new.organization_id
     and contact_id = new.id;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_captacoes_do_contato_anonimizado() from public, anon, authenticated;
grant execute on function public.fn_redigir_captacoes_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_captacoes_ao_anonimizar on public.contacts;
create trigger trg_redigir_captacoes_ao_anonimizar
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function public.fn_redigir_captacoes_do_contato_anonimizado();
