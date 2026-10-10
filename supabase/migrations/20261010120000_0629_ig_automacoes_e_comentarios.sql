-- manifest: tabelas ig_automation_flows e ig_comment_events — motor ManyChat próprio para Instagram DM e comentários, com automação baseada em palavras-chave e etiquetas políticas (GIP War Room 2.0)

-- ══════════════════════════════════════════════════════════════════
-- ig_automation_flows — regras de automação tipo ManyChat
--
-- Cada linha é uma automação: trigger (tipo + config) → lista de ações.
-- Exemplos de trigger_tipo: 'comment_keyword', 'comment_no_post',
--   'dm_keyword', 'novo_seguidor', 'story_reply'.
-- Exemplos de ação em acoes[]: responder_comentario, enviar_dm,
--   add_etiqueta, criar_contato, notificar_equipe.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.ig_automation_flows (
  id                      uuid         primary key default gen_random_uuid(),
  organization_id         uuid         not null references public.organizations(id) on delete cascade,
  nome                    text         not null check (char_length(nome) between 1 and 120),
  descricao               text,
  ativo                   boolean      not null default true,
  -- Tipo de gatilho. Vocabulário aberto (sem CHECK — clone pode ter legado).
  -- Valores canônicos: 'comment_keyword' | 'comment_no_post' | 'dm_keyword'
  --   | 'novo_seguidor' | 'story_reply' | 'novo_comentario'
  trigger_tipo            text         not null,
  -- Config do gatilho como JSONB.
  -- comment_keyword : { keywords: string[], case_sensitive?: bool, post_ids?: string[] }
  -- comment_no_post : { post_ids: string[] }
  -- dm_keyword      : { keywords: string[], case_sensitive?: bool }
  -- novo_seguidor   : {}
  -- story_reply     : { story_id?: string }
  -- novo_comentario : {}
  trigger_config          jsonb        not null default '{}',
  -- Array de ações executadas EM ORDEM quando o gatilho dispara.
  -- Exemplo: [
  --   { "tipo": "enviar_dm",           "texto": "Oi {{nome}}! ..." },
  --   { "tipo": "add_etiqueta",        "etiqueta": "Simpatizante" },
  --   { "tipo": "responder_comentario","texto": "Obrigado! ..." },
  --   { "tipo": "criar_contato",       "pipeline_id": "uuid" },
  --   { "tipo": "notificar_equipe",    "mensagem": "Novo lead via IG" }
  -- ]
  acoes                   jsonb        not null default '[]',
  -- Estatísticas de uso (atualizadas pelo worker, JSONB para flexibilidade)
  stats                   jsonb        not null default '{"total_acionamentos":0}',
  ultima_ativacao_at      timestamptz,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);

comment on table public.ig_automation_flows is
  'Motor ManyChat próprio do DeskcommCRM: regras de automação para Instagram DM e comentários. Cada linha é um fluxo com gatilho + lista de ações executadas em ordem.';

comment on column public.ig_automation_flows.trigger_tipo is
  'Tipo de gatilho: comment_keyword, comment_no_post, dm_keyword, novo_seguidor, story_reply, novo_comentario. Coluna aberta (sem CHECK) para suportar extensões.';

comment on column public.ig_automation_flows.acoes is
  'Array de ações em ordem. Tipos suportados: enviar_dm, responder_comentario, add_etiqueta, criar_contato, notificar_equipe, add_funil_politico. Extensível sem migration.';

-- Índice para busca por org + ativo (drain do worker)
create index if not exists ig_automation_flows_org_ativo_idx
  on public.ig_automation_flows (organization_id, ativo);

create index if not exists ig_automation_flows_org_trigger_idx
  on public.ig_automation_flows (organization_id, trigger_tipo);

-- Touch automático do updated_at
create or replace trigger ig_automation_flows_touch
  before update on public.ig_automation_flows
  for each row execute function public.fn_touch_updated_at();

-- ══════════════════════════════════════════════════════════════════
-- ig_comment_events — comentários Instagram recebidos via Graph API
--
-- Cada linha é um comentário recebido. O unique index garante
-- idempotência: reentrega do webhook não duplica.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.ig_comment_events (
  id                        uuid         primary key default gen_random_uuid(),
  organization_id           uuid         not null references public.organizations(id) on delete cascade,
  -- Sessão do canal Instagram (channel_sessions com provider=zernio_social, platform=instagram)
  channel_session_id        uuid         references public.channel_sessions(id) on delete set null,
  -- Identificadores do Instagram Graph API
  instagram_comment_id      text         not null,
  instagram_post_id         text,          -- post onde o comentário foi feito
  instagram_media_id        text,          -- mídia associada (pode diferir do post)
  -- Quem comentou
  from_instagram_id         text         not null,
  from_username             text,
  -- Conteúdo do comentário
  texto                     text,
  -- Estado de resposta
  respondido_em_comentario  boolean      not null default false,
  resposta_comentario_at    timestamptz,
  dm_enviada                boolean      not null default false,
  dm_enviada_at             timestamptz,
  -- Qual flow foi acionado (se houver)
  flow_acionado_id          uuid         references public.ig_automation_flows(id) on delete set null,
  -- Payload bruto do webhook para auditoria/debugging
  payload_raw               jsonb        not null default '{}',
  -- Processamento pelo worker
  processado                boolean      not null default false,
  processado_at             timestamptz,
  created_at                timestamptz  not null default now()
);

comment on table public.ig_comment_events is
  'Comentários recebidos via Instagram Graph API webhooks. Idempotente por (organization_id, instagram_comment_id). Worker de automação lê daqui para disparar os flows.';

-- Idempotência: reentrega do webhook não duplica comentário
create unique index if not exists ig_comment_events_org_comment_uniq
  on public.ig_comment_events (organization_id, instagram_comment_id);

-- Worker drain: pendentes por org
create index if not exists ig_comment_events_org_processado_idx
  on public.ig_comment_events (organization_id, processado, created_at)
  where not processado;

-- Busca por post (para analytics e filtro de flows)
create index if not exists ig_comment_events_org_post_idx
  on public.ig_comment_events (organization_id, instagram_post_id);

-- Busca por comentador (para funil político)
create index if not exists ig_comment_events_org_from_idx
  on public.ig_comment_events (organization_id, from_instagram_id);

-- ══════════════════════════════════════════════════════════════════
-- ig_webhook_tokens — mapeamento token → org + sessão Instagram
--
-- O path_token na URL do webhook identifica a organização sem
-- expor IDs internos. Análogo ao webhook_sources.path_token, mas
-- específico para o canal de comentários do Instagram Graph API.
-- O App Secret para verificação HMAC-SHA256 vem de platform_meta_app
-- (compartilhado com WhatsApp Cloud API — mesmo app Meta).
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.ig_webhook_tokens (
  id                  uuid         primary key default gen_random_uuid(),
  organization_id     uuid         not null references public.organizations(id) on delete cascade,
  -- Sessão Instagram (canal Zernio Social com platform=instagram)
  channel_session_id  uuid         references public.channel_sessions(id) on delete cascade,
  -- Token público na URL: /api/v1/webhooks/instagram-comments/[token]
  path_token          text         not null unique default encode(gen_random_bytes(24), 'base64url'),
  -- Instagram Business Account ID desta sessão
  ig_business_account_id text,
  -- Verify token configurado no painel Meta (para handshake GET)
  verify_token        text         not null default encode(gen_random_bytes(16), 'hex'),
  ativo               boolean      not null default true,
  created_at          timestamptz  not null default now(),
  updated_at          timestamptz  not null default now()
);

comment on table public.ig_webhook_tokens is
  'Tokens de webhook para o canal de comentários do Instagram Graph API. O path_token identifica a org na URL pública; verify_token é configurado no painel Meta para o handshake de verificação.';

create unique index if not exists ig_webhook_tokens_org_session_uniq
  on public.ig_webhook_tokens (organization_id, channel_session_id);

create index if not exists ig_webhook_tokens_org_idx
  on public.ig_webhook_tokens (organization_id);

create or replace trigger ig_webhook_tokens_touch
  before update on public.ig_webhook_tokens
  for each row execute function public.fn_touch_updated_at();

-- ══════════════════════════════════════════════════════════════════
-- RLS — isolamento por tenant (obrigatório: CLAUDE.md)
-- ══════════════════════════════════════════════════════════════════

alter table public.ig_automation_flows   enable row level security;
alter table public.ig_comment_events     enable row level security;
alter table public.ig_webhook_tokens     enable row level security;

-- ig_automation_flows
create policy tenant_isolation_ig_automation_flows_all
  on public.ig_automation_flows
  for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ig_comment_events
create policy tenant_isolation_ig_comment_events_all
  on public.ig_comment_events
  for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ig_webhook_tokens
create policy tenant_isolation_ig_webhook_tokens_all
  on public.ig_webhook_tokens
  for all
  using (organization_id = any(public.fn_user_org_ids()))
  with check (organization_id = any(public.fn_user_org_ids()));

-- ══════════════════════════════════════════════════════════════════
-- Função: buscar token de webhook por path_token (usada pelo handler)
-- Security definer para que o handler (service role) resolva o token
-- sem expor a tabela inteira ao anon.
-- ══════════════════════════════════════════════════════════════════

create or replace function public.fn_ig_webhook_token_por_path(
  p_path_token text
)
returns table (
  organization_id      uuid,
  channel_session_id   uuid,
  ig_business_account_id text,
  verify_token         text,
  ativo                boolean
)
language sql
security definer
stable
as $$
  select
    organization_id,
    channel_session_id,
    ig_business_account_id,
    verify_token,
    ativo
  from public.ig_webhook_tokens
  where path_token = p_path_token
  limit 1;
$$;

revoke execute on function public.fn_ig_webhook_token_por_path(text) from public, anon;
grant  execute on function public.fn_ig_webhook_token_por_path(text) to service_role;

comment on function public.fn_ig_webhook_token_por_path(text) is
  'Resolve um webhook token de Instagram por path_token. Usada pelo handler de comentários para identificar a org sem expor a tabela ao anon. Security definer — só service_role pode executar.';
