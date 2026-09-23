-- 0375 — CAMPANHAS (Sub-PRD 12 / Spec 12 / Spec 13)
--
-- ═══ O que nasce aqui, e o que deliberadamente NÃO nasce ═══
--
-- Duas tabelas: a campanha e o destinatário. Nenhuma tabela de proteção de envio,
-- nenhuma tabela de template, nenhuma suppression list.
--
--   * Proteção de envio (Spec 13 §4.1 pede `channel_send_protection`): já existe
--     neste repo e tem tela — `channel_knobs` (throttle, jitter, janela, domingo,
--     fuso, warm-up) mais `channel_sessions.daily_message_limit`, editados pela
--     `AntiBanSheet` (cujo título é, literalmente, "Proteção de envio"), e
--     respeitados por `decidePacing` com contador real em `pacing_ledger`. Criar a
--     tabela da spec daria à mesma instalação DUAS janelas e DOIS tetos por
--     conexão, e alguém teria de decidir qual ganha em cada caminho de envio — o
--     anti-pattern nº 2 do CLAUDE.md (duplicação sem source of truth). O que a
--     campanha ganha aqui é só o OVERRIDE dela, sempre mais restritivo que o canal.
--   * Templates internos e suppression list ficam fora do MVP por decisão do dono
--     do produto (2026-09-18). A coluna de conteúdo é uma só e é texto.
--   * `message_mode`/`provider_template_*` (Spec 12 §2.1) não entram: este fork
--     envia por WAHA, e coluna que ninguém escreve é promessa de recurso que não
--     existe. Quando o canal oficial entrar, entra com a migration dele.
--
-- ═══ Por que destinatário é LINHA e não lista em jsonb ═══
--
-- É ele que tem estado individual (pendente/enviado/pulado + motivo), unicidade
-- (ninguém recebe duas vezes) e contagem para o relatório. Em jsonb, cada envio
-- reescreveria o documento inteiro e duas rodadas concorrentes do cron perderiam
-- uma da outra.
--
-- ═══ Base legal não tem default ═══
--
-- Campanha sem base legal declarada não deve existir, e um default plausível aqui
-- seria exatamente o buraco que a Regra nº 1 proíbe: pareceria configurado e não
-- estaria. Interesse legítimo SEM a referência da LIA é o mesmo que nenhuma base
-- legal — é a referência que permite responder "com base em quê você me mandou
-- isto?" (vault: LIA-2026-01). O gate de LGPD da cadeia de envio
-- (`lib/agent-engine/guardrails/lgpd/legal-basis.ts`) usa a mesma régua.

create table if not exists public.campaigns (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  name text not null,
  description text,

  -- Os nove estados da Spec 12 §7.1. As transições válidas vivem em
  -- `lib/campanhas/maquina-de-estados.ts` — CHECK aqui guarda o VOCABULÁRIO, não a
  -- ordem: uma matriz de transição em SQL exigiria trigger, e trigger que decide
  -- fluxo é lógica de produto fora do lugar onde ela é testável.
  status text not null default 'draft',

  -- `on delete restrict`: apagar o número que uma campanha usou apagaria o
  -- histórico de para quem ela falou. Quem quiser sumir com o número arquiva a
  -- campanha antes.
  channel_session_id uuid not null,

  message_body text,

  base_legal text not null,
  lia_ref text,

  audience_filter jsonb not null default '{}'::jsonb,
  -- Sobe a cada preparação nova. O destinatário guarda a versão do CONTEÚDO com
  -- que foi congelado; a da audiência distingue snapshots entre si.
  audience_version integer not null default 1,
  content_version integer not null default 1,

  -- ═══ Ritmo PRÓPRIO da campanha (Spec 13 §4.2) ═══
  -- Todas nullable: null = herda do canal. O efetivo é sempre o MAIS RESTRITIVO
  -- entre campanha e canal — a campanha só sabe ir mais devagar, nunca mais
  -- rápido. Para lista FRIA o ritmo do canal não basta: 30 mensagens em 30 min do
  -- mesmo número, para quem nunca falou com a empresa, é o padrão que o WhatsApp
  -- bane, e número banido volta em semanas de warm-up, não em dias.
  intervalo_segundos integer,
  janela_inicio_hora smallint,
  janela_fim_hora smallint,
  teto_diario integer,
  teto_horario integer,

  scheduled_at timestamptz,
  prepared_at timestamptz,
  started_at timestamptz,
  paused_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_detail text,

  snapshot_total integer not null default 0,
  snapshot_eligible integer not null default 0,
  snapshot_excluded integer not null default 0,

  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaigns_status_check check (status in (
    'draft','preparing','ready','scheduled','running',
    'paused','completed','cancelled','failed'
  )),
  constraint campaigns_name_check check (btrim(name) <> ''),
  constraint campaigns_base_legal_check check (base_legal in ('consent','legitimate_interest')),
  constraint campaigns_lia_exige_ref check (
    base_legal <> 'legitimate_interest' or coalesce(btrim(lia_ref), '') <> ''
  ),
  -- Faixas de sanidade do ritmo. Não são o default de comportamento (esse mora em
  -- `lib/agent-engine/pacing/defaults.ts`, fonte única dos números de pacing):
  -- são o que a coluna aceita de um operador.
  constraint campaigns_intervalo_check check (
    intervalo_segundos is null or intervalo_segundos between 1 and 86400
  ),
  constraint campaigns_janela_check check (
    (janela_inicio_hora is null and janela_fim_hora is null)
    or (janela_inicio_hora between 0 and 23
        and janela_fim_hora between 1 and 24
        and janela_fim_hora > janela_inicio_hora)
  ),
  constraint campaigns_teto_diario_check check (teto_diario is null or teto_diario between 1 and 10000),
  constraint campaigns_teto_horario_check check (teto_horario is null or teto_horario between 1 and 10000)
);

-- FK composta pela doutrina multi-tenant: uma campanha não pode apontar para o
-- número de OUTRA organização. Alvo é `uq_channel_sessions_org_id` (0262/0228).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaigns_channel_org_fk'
  ) then
    alter table public.campaigns
      add constraint campaigns_channel_org_fk
      foreign key (organization_id, channel_session_id)
      references public.channel_sessions (organization_id, id)
      on delete restrict;
  end if;
end $$;

comment on table public.campaigns is
  'Envio proativo a uma lista explícita de contatos, por um número. O ritmo próprio (intervalo/janela/tetos) é sempre mais restritivo que o do canal (channel_knobs + channel_sessions.daily_message_limit), nunca mais frouxo.';
comment on column public.campaigns.base_legal is
  'Base legal do tratamento (LGPD art. 7º). Sem default de propósito: campanha sem base legal declarada não deve existir. `legitimate_interest` exige `lia_ref` — a referência da avaliação de interesse legítimo que responde "com base em quê você me mandou isto?".';
comment on column public.campaigns.content_version is
  'Sobe quando o texto muda. O destinatário guarda a versão com que foi congelado, para edição futura não reescrever mensagem já preparada.';

create index if not exists idx_campaigns_org_status
  on public.campaigns (organization_id, status, created_at desc);

-- A pergunta do scheduler: quais campanhas agendadas já venceram.
create index if not exists idx_campaigns_agendadas
  on public.campaigns (scheduled_at)
  where status = 'scheduled';

create table if not exists public.campaign_recipients (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  -- Preenchida no envio, não no snapshot: a conversa pode nem existir quando a
  -- lista é montada.
  conversation_id uuid references public.conversations(id) on delete set null,

  -- O telefone CONGELADO no snapshot. O contato continua sendo a fonte da verdade
  -- do CRM, mas a campanha não recalcula retroativamente para quem ela ia falar.
  recipient_address text,

  status text not null default 'pending',
  eligibility_status text not null default 'eligible',
  -- Código, não frase: a frase legível mora no TypeScript e é traduzida.
  exclusion_reason text,

  variables jsonb not null default '{}'::jsonb,
  rendered_body text,
  content_version integer not null default 1,

  message_id uuid references public.messages(id) on delete set null,

  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  last_error_detail text,

  queued_at timestamptz,
  sending_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  replied_at timestamptz,
  opted_out_at timestamptz,
  cancelled_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaign_recipients_status_check check (status in (
    'pending','queued','sending','sent','delivered','read','replied',
    'failed','skipped','cancelled','opted_out'
  )),
  constraint campaign_recipients_eligibility_check check (
    eligibility_status in ('eligible','excluded')
  ),
  -- Ninguém recebe duas vezes: nem pelo mesmo cadastro, nem por dois cadastros
  -- gêmeos com o mesmo número. A segunda unicidade tolera NULL (excluído sem
  -- telefone não disputa endereço com ninguém).
  constraint campaign_recipients_contato_unico unique (campaign_id, contact_id),
  constraint campaign_recipients_endereco_unico unique (campaign_id, recipient_address)
);

comment on table public.campaign_recipients is
  'O snapshot: para quem a campanha IA falar, congelado na preparação, com o estado individual de cada envio. Fonte da verdade das métricas — os contadores em campaigns são cache.';
comment on column public.campaign_recipients.recipient_address is
  'Telefone congelado no snapshot. Nunca sai em log (a doutrina proíbe PII em log); quem precisa correlacionar usa o id.';

-- A fila do worker: pendentes de UMA campanha, na ordem de entrada, respeitando
-- reagendamento por ritmo.
create index if not exists idx_campaign_recipients_fila
  on public.campaign_recipients (campaign_id, next_attempt_at, created_at)
  where status in ('pending', 'queued');

-- O caminho do ack: da mensagem de volta ao destinatário.
create index if not exists idx_campaign_recipients_message
  on public.campaign_recipients (message_id)
  where message_id is not null;

-- A pergunta da atribuição de resposta: o envio mais recente a este contato.
create index if not exists idx_campaign_recipients_contato_envio
  on public.campaign_recipients (organization_id, contact_id, sent_at desc);

-- A reconciliação de `sending` travado.
create index if not exists idx_campaign_recipients_enviando
  on public.campaign_recipients (sending_at)
  where status = 'sending';

drop trigger if exists trg_campaigns_updated_at on public.campaigns;
create trigger trg_campaigns_updated_at
  before update on public.campaigns
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_campaign_recipients_updated_at on public.campaign_recipients;
create trigger trg_campaign_recipients_updated_at
  before update on public.campaign_recipients
  for each row execute function public.fn_set_updated_at();

-- ═══ Entregue/lido: o ack da mensagem chega ao destinatário ═══
--
-- Não há hook de aplicação para mudança de status de mensagem: o trigger
-- `trg_messages_emit_event` é AFTER **INSERT**, então UPDATE de status não emite
-- evento nenhum (o `recover-stuck-messages` documenta isso e emite à mão). As
-- alternativas eram polling no cron — que só descobre a entrega no tique seguinte
-- e varre a tabela de mensagens — ou este trigger, que é local ao banco, roda na
-- mesma transação do ack e não faz I/O externo (o anti-pattern nº 9 é trigger que
-- fala HTTP; este não fala com ninguém).
--
-- Regra dura: status analítico NUNCA retrocede. `read` não volta para `delivered`,
-- e `replied`/`opted_out`/`cancelled` não voltam para nada — resposta é o desfecho
-- mais forte, e um ack atrasado não pode desfazê-lo.
create or replace function public.fn_campanha_sincroniza_ack() returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  update public.campaign_recipients r
     set delivered_at = case
           when new.status in ('delivered', 'read')
             then coalesce(r.delivered_at, new.delivered_at, now())
           else r.delivered_at end,
         read_at = case
           when new.status = 'read' then coalesce(r.read_at, new.read_at, now())
           else r.read_at end,
         sent_at = case
           when new.status in ('sent', 'delivered', 'read')
             then coalesce(r.sent_at, new.sent_at, now())
           else r.sent_at end,
         status = case
           when r.status in ('replied', 'opted_out', 'cancelled') then r.status
           when new.status = 'read' then 'read'
           when new.status = 'delivered' and r.status in ('queued', 'sending', 'sent') then 'delivered'
           when new.status = 'sent' and r.status in ('queued', 'sending') then 'sent'
           when new.status = 'failed' and r.status in ('queued', 'sending', 'sent') then 'failed'
           else r.status end,
         last_error_code = case
           when new.status = 'failed' then coalesce(new.error_code, r.last_error_code)
           else r.last_error_code end,
         last_error_detail = case
           when new.status = 'failed' then coalesce(new.error_message, r.last_error_detail)
           else r.last_error_detail end,
         updated_at = now()
   where r.message_id = new.id;

  return new;
end
$$;

comment on function public.fn_campanha_sincroniza_ack() is
  'Trigger de messages: leva o ack do canal (sent/delivered/read/failed) ao campaign_recipients daquela mensagem. Status analítico nunca retrocede.';

-- As DUAS origens de EXECUTE (CLAUDE.md, doutrina de migrations item 9): o grant
-- que o Postgres dá a PUBLIC ao criar, e o `alter default privileges ... to anon`
-- do baseline, que vale para toda função criada depois dele. `authenticated`
-- entra na lista pelo mesmo motivo. O trigger não depende de nenhum deles: a
-- permissão de função de trigger é conferida na CRIAÇÃO do trigger, não a cada
-- disparo.
revoke execute on function public.fn_campanha_sincroniza_ack() from public, anon, authenticated;
grant execute on function public.fn_campanha_sincroniza_ack() to service_role;

drop trigger if exists trg_messages_sincroniza_campanha on public.messages;
create trigger trg_messages_sincroniza_campanha
  after update of status on public.messages
  for each row
  when (new.direction = 'outbound')
  execute function public.fn_campanha_sincroniza_ack();

-- ═══ LGPD: o contato anonimizado não deixa telefone nem texto para trás ═══
--
-- `campaign_recipients` guarda telefone congelado e o corpo renderizado (que
-- carrega o nome). Anonimizar o contato sem alcançar estas colunas devolveria
-- SUCESSO com o dado legível — a pior falha possível numa obrigação legal,
-- porque nada erra e nada loga.
--
-- TRIGGER e não um 9º passo dentro de `fn_lgpd_cascade_redact_contact`, pelo
-- mesmo motivo escrito no apêndice da 0174: aquela função tem 180 linhas e
-- reescrevê-la aqui criaria duas cópias que divergem no primeiro conserto. O
-- gancho é a transição `is_anonymized false → true`, que é o último fato da
-- anonimização, roda na MESMA transação e alcança QUALQUER caminho que anonimize
-- — inclusive os que não passam pela função.
--
-- O endereço vira NULL e não texto redigido: com NULL, o destinatário pendente
-- cai no veto `sem_telefone` do próximo despacho, e nenhuma mensagem sai para
-- quem exerceu o direito de apagamento. Linha enviada continua contando nas
-- métricas (contagem não é dado pessoal).
create or replace function public.fn_redigir_campanhas_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_anonymized is true and coalesce(old.is_anonymized, false) is false then
    update public.campaign_recipients
       set recipient_address = null,
           rendered_body = null,
           variables = '{}'::jsonb,
           last_error_detail = null,
           updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_campanhas_do_contato_anonimizado() from public, anon, authenticated;
grant execute on function public.fn_redigir_campanhas_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_campanhas_anonimizado on public.contacts;
create trigger trg_redigir_campanhas_anonimizado
  after update of is_anonymized on public.contacts
  for each row
  execute function public.fn_redigir_campanhas_do_contato_anonimizado();

-- ═══ RLS ═══
--
-- Padrão da 0261: SELECT aberto ao tenant, ESCRITA a partir de `manager`. Policy
-- `ALL` só-tenancy em tabela nova é reprovada por `rbac-config-ia-canais.test.ts`
-- — e com razão: quem fala direto com o PostgREST usando o próprio JWT não passa
-- pelo `requireRole()` das rotas, e disparar para uma lista de gente não é gesto
-- de `viewer`. `manager` e não `admin` por decisão do dono (2026-09-18): na matriz
-- do PRD §5.2 os dois operam campanha igual.
alter table public.campaigns enable row level security;

drop policy if exists tenant_isolation_campaigns_all on public.campaigns;
drop policy if exists campaigns_select on public.campaigns;
create policy campaigns_select on public.campaigns
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaigns_write on public.campaigns;
create policy campaigns_write on public.campaigns
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.campaigns from anon, authenticated;
grant select on public.campaigns to authenticated;
grant all on public.campaigns to service_role;

alter table public.campaign_recipients enable row level security;

drop policy if exists tenant_isolation_campaign_recipients_all on public.campaign_recipients;
drop policy if exists campaign_recipients_select on public.campaign_recipients;
create policy campaign_recipients_select on public.campaign_recipients
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaign_recipients_write on public.campaign_recipients;
create policy campaign_recipients_write on public.campaign_recipients
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.campaign_recipients from anon, authenticated;
grant select on public.campaign_recipients to authenticated;
grant all on public.campaign_recipients to service_role;
