-- 0376 — TEMPLATES E LISTA DE EXCLUSÃO DE CAMPANHA (Spec 12 §2.3 e §2.4)
--
-- As duas tabelas ficaram de fora da 0375 por decisão de escopo do dono
-- (2026-09-18: "MVP é texto livre"). Entram agora, pedidas na tela, com a
-- diferença de que não são mais projeto: cada uma resolve um problema medido.
--
-- ═══ `campaign_templates` — a copy que sobrevive à campanha ═══
--
-- Hoje o texto vive dentro de UMA campanha. Quem escreveu uma abordagem que
-- funciona e quer usá-la de novo copia e cola — e a cada cópia a versão boa e a
-- versão velha ficam indistinguíveis. O template guarda a copy fora da execução.
--
-- Conteúdo de campanha JÁ PREPARADA não muda quando o template muda: o texto é
-- congelado por destinatário em `campaign_recipients.rendered_body` com o
-- `content_version` junto. Editar um template amanhã não reescreve o que alguém
-- recebeu ontem.
--
-- ═══ `campaign_suppressions` — parar de falar com alguém sem apagá-lo ═══
--
-- Diferente de opt-out: o opt-out é do TITULAR (ele pediu, e `contacts.is_blocked`
-- responde por isso em todo o produto). A suppression é da OPERAÇÃO — "não
-- mande campanha para este número" — e não deve mexer no cadastro do contato
-- nem no que o agente pode responder quando ELE escreve.
--
-- Guarda HASH e não o telefone: dedup e consulta funcionam igual, e uma lista de
-- "não mandar" não precisa virar um segundo lugar onde telefone de gente mora.
--
-- Mesmo assim ela ENTRA na cascata de anonimização, e a primeira versão deste
-- cabeçalho dizia o contrário: "guarda hash, logo não há PII". O invariante
-- `lgpd-cascata-alcanca-quem-guarda-pessoa` discordou, e estava certo — a linha
-- guarda `contact_id` e os últimos dígitos, e os dois juntos dizem de QUEM ela é.
-- O trigger abaixo apaga esses dois e PRESERVA o hash, que é o veto.

create table if not exists public.campaign_templates (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  body text not null,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_templates_name_check check (btrim(name) <> ''),
  constraint campaign_templates_body_check check (btrim(body) <> ''),
  -- Dois templates com o mesmo nome na mesma organização é a receita para usar
  -- o errado: quem escolhe na tela escolhe pelo nome.
  constraint campaign_templates_nome_unico unique (organization_id, name)
);

comment on table public.campaign_templates is
  'Copy reutilizável de campanha. Não é template de provedor (Meta): é texto livre com as mesmas variáveis do renderizador. Campanha preparada não muda quando o template muda — o conteúdo é congelado por destinatário.';

create index if not exists idx_campaign_templates_org
  on public.campaign_templates (organization_id, name);

create table if not exists public.campaign_suppressions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Nullable: dá para excluir um número que ainda não é contato de ninguém.
  contact_id uuid references public.contacts(id) on delete set null,
  recipient_address_hash text not null,
  -- Só os últimos dígitos, para a tela dizer DE QUEM é a linha sem guardar o
  -- número inteiro. "termina em 4321" basta para a pessoa reconhecer o que ela
  -- mesma cadastrou.
  address_tail text,
  reason text,
  source text not null default 'manual',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint campaign_suppressions_source_check check (source in ('manual', 'import', 'sistema')),
  constraint campaign_suppressions_unico unique (organization_id, recipient_address_hash)
);

comment on table public.campaign_suppressions is
  'Lista de exclusão da OPERAÇÃO: não mandar campanha para este endereço. Diferente do opt-out, que é do titular e vive em contacts.is_blocked — aqui não se mexe no cadastro nem no que o agente responde a quem escreve. Guarda hash, nunca o telefone.';
comment on column public.campaign_suppressions.recipient_address_hash is
  'SHA-256 do telefone normalizado (E.164). O mesmo cálculo mora em lib/campanhas/exclusoes.ts — mudar um lado sem o outro faz a lista parar de casar, em silêncio.';

create index if not exists idx_campaign_suppressions_org
  on public.campaign_suppressions (organization_id, created_at desc);

drop trigger if exists trg_campaign_templates_updated_at on public.campaign_templates;
create trigger trg_campaign_templates_updated_at
  before update on public.campaign_templates
  for each row execute function public.fn_set_updated_at();

-- ═══ LGPD: anonimizar apaga o que APONTA para a pessoa, e preserva o veto ═══
--
-- A lista guarda hash, e hash não reidentifica ninguém. Mas ela guarda também
-- `contact_id` e os últimos dígitos — e esses dois, juntos, dizem de QUEM é a
-- linha. Ao anonimizar, os dois saem.
--
-- O HASH FICA, e isso é deliberado: ele é o veto. Apagá-lo devolveria o número
-- para dentro das campanhas no dia em que o contato fosse anonimizado — o
-- oposto do que o titular pediu. O que sobra é uma linha que impede envio para
-- um número que ninguém consegue ler a partir dela.
create or replace function public.fn_redigir_exclusoes_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_anonymized is true and coalesce(old.is_anonymized, false) is false then
    update public.campaign_suppressions
       set contact_id = null,
           address_tail = null,
           reason = null
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_redigir_exclusoes_do_contato_anonimizado() from public, anon, authenticated;
grant execute on function public.fn_redigir_exclusoes_do_contato_anonimizado() to service_role;

drop trigger if exists trg_redigir_exclusoes_anonimizado on public.contacts;
create trigger trg_redigir_exclusoes_anonimizado
  after update of is_anonymized on public.contacts
  for each row
  execute function public.fn_redigir_exclusoes_do_contato_anonimizado();

-- ═══ RLS — mesmo padrão da 0375 ═══
-- SELECT para o tenant; escrita a partir de `manager`. Policy `ALL` só-tenancy
-- em tabela nova é reprovada por `rbac-config-ia-canais.test.ts`.
alter table public.campaign_templates enable row level security;

drop policy if exists campaign_templates_select on public.campaign_templates;
create policy campaign_templates_select on public.campaign_templates
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaign_templates_write on public.campaign_templates;
create policy campaign_templates_write on public.campaign_templates
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

revoke all on public.campaign_templates from anon, authenticated;
grant select on public.campaign_templates to authenticated;
grant all on public.campaign_templates to service_role;

alter table public.campaign_suppressions enable row level security;

drop policy if exists campaign_suppressions_select on public.campaign_suppressions;
create policy campaign_suppressions_select on public.campaign_suppressions
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists campaign_suppressions_write on public.campaign_suppressions;
create policy campaign_suppressions_write on public.campaign_suppressions
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

revoke all on public.campaign_suppressions from anon, authenticated;
grant select on public.campaign_suppressions to authenticated;
grant all on public.campaign_suppressions to service_role;
