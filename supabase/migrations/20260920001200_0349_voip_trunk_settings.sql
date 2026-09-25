-- 0349_voip_trunk_settings (nasceu 0257 no PR #677; renumerada)
--
-- Tela de configuração de trunk SIP por organização — hoje o único trunk do
-- módulo de voz (Asterisk/AudioSocket, #677) vive hardcoded em
-- `asterisk/pjsip.conf`, um arquivo na VPS, fora do banco. Decisão: um trunk
-- por organização, configurável numa tela (Configurações > Trunk SIP).
--
-- Aplicar no Asterisk continua MANUAL por enquanto (decisão explícita) —
-- esta tabela só guarda e exibe; não há reload automático de `pjsip.conf`
-- nesta fase. `organization_id` é a CHAVE PRIMÁRIA (mesmo padrão de
-- `org_voice_calls`/`org_guardrail_layers`): é config de UM trunk por
-- organização, não uma lista.
--
-- Senha cifrada com o MESMO esquema AES-256-GCM de `ai_provider_credentials`
-- (`lib/crypto/aes_gcm.ts`, chave `AI_CRED_AES_KEY`) — nunca plaintext em
-- disco. Só `password_last4` é exposto pela view segura
-- (`voip_trunk_settings_safe`), mesmo padrão de `api_key_last4`.

create table if not exists public.voip_trunk_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  host text not null,
  port integer not null default 5060,
  username text not null,
  password_encrypted bytea not null,
  password_iv bytea not null,
  password_tag bytea not null,
  password_last4 text not null,
  from_domain text,
  endpoint_name text not null,
  is_active boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.voip_trunk_settings enable row level security;

-- Leitura: qualquer membro da org (a tela de originar chamada precisa saber
-- SE existe trunk configurado). Escrita: só admin — são credenciais de um
-- provedor SIP real, o mesmo nível de sensibilidade de ai_provider_credentials.
drop policy if exists voip_trunk_settings_select on public.voip_trunk_settings;
create policy voip_trunk_settings_select on public.voip_trunk_settings
  for select using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists voip_trunk_settings_admin_write on public.voip_trunk_settings;
create policy voip_trunk_settings_admin_write on public.voip_trunk_settings
  for all
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'admin')
  );

-- A anon key vai para o browser — sem isto, o GRANT ALL ON TABLES TO anon do
-- baseline (que vale pra toda tabela nova) deixaria a tabela alcançável sem
-- sessão nenhuma, RLS ou não.
revoke all on public.voip_trunk_settings from anon;

drop trigger if exists trg_voip_trunk_settings_set_updated_at on public.voip_trunk_settings;
create trigger trg_voip_trunk_settings_set_updated_at
  before update on public.voip_trunk_settings
  for each row execute function public.fn_set_updated_at();

-- View segura: NUNCA expõe password_encrypted/iv/tag — mesmo padrão de
-- ai_provider_credentials_safe. security_invoker=true: a view roda com o
-- privilégio de quem CONSULTA, então a RLS da tabela base (acima) se aplica
-- através dela também — sem isto, uma view SECURITY DEFINER furaria o RLS.
create or replace view public.voip_trunk_settings_safe
  with (security_invoker = true) as
select
  organization_id, host, port, username, password_last4, from_domain,
  endpoint_name, is_active, updated_by, created_at, updated_at
from public.voip_trunk_settings;

revoke all on public.voip_trunk_settings_safe from anon;
grant select on public.voip_trunk_settings_safe to authenticated;

notify pgrst, 'reload schema';
