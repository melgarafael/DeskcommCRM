-- manifest: **Grupos opcionais de respostas rápidas (#3245).** Tabela nova `message_template_groups` (nome + ordem por organização) e a coluna nulável `message_templates.grupo_id`, com FK COMPOSTA `(organization_id, grupo_id)`: uma resposta só aponta para grupo da MESMA organização, e apagar o grupo devolve as respostas dele à lista plana (`on delete set null (grupo_id)`) — nada é apagado junto. RLS: leitura por qualquer membro da organização, escrita por `manager+` (grupo é estrutura compartilhada, como a resposta compartilhada); `anon` sem privilégio nenhum e grant EXPLÍCITO a `authenticated`, provado por teste de acesso por papel. Sem grupo, a tela e o Inbox renderizam a lista de hoje, byte a byte. Idempotente; espelho verbatim no `baseline.sql`.

-- 0808 — grupos de respostas rápidas.
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. `message_template_groups`: o grupo ("Atendimento inicial", "Follow-up",
--      "Negociação"…). O nome é único por organização com `lower(btrim(name))`
--      — "Follow-up" e "follow-up " seriam o mesmo grupo para quem lê a tela.
--      A ordem é a da exibição, fracionária (`numeric`) como
--      `message_templates.ordem` (0729), para reordenar sem renumerar a lista.
--   2. `message_templates.grupo_id`: o VÍNCULO, NULÁVEL de propósito. É ele que
--      torna o recurso opcional: linha anterior a esta migration (e resposta que
--      a tela não vinculou) fica `null`, e `null` é "lista plana de hoje".
--
-- ─── Por que FK COMPOSTA, e não uma FK simples em `grupo_id` ───────────────
--
-- Uma FK simples só conhece o id: um corpo forjado gravaria `grupo_id` de
-- OUTRA organização — o id existe, a FK aceita, e a resposta passa a apontar
-- para um grupo que quem gravou nem lê. A FK composta `(organization_id,
-- grupo_id)` exige que o par exista do outro lado, e o par só existe se o grupo
-- for da mesma organização (é a mesma régua de `attendant_sector_members`).
--
-- ─── Por que `on delete set null (grupo_id)` e não cascata ────────────────
--
-- Apagar um grupo não pode apagar as respostas rápidas: elas são o conteúdo que
-- a equipe usa todo dia, e "excluí o grupo" não é "excluí os scripts". O
-- `(grupo_id)` da lista de colunas é obrigatório — sem ele o SET NULL tentaria
-- anular `organization_id` junto, que é NOT NULL, e o DELETE explodiria só na
-- hora de apagar um grupo com respostas, em produção.
--
-- ─── Compatibilidade ───────────────────────────────────────────────────────
--
-- Tabela nova e coluna NULÁVEL, sem backfill: nenhuma resposta existente muda
-- de lugar, nenhuma tela passa a agrupar por conta própria. Tudo
-- `if not exists` / `drop constraint if exists` — reaplicável pelo `update.sh`.
-- O recurso é OPCIONAL: quem nunca criar grupo continua com a lista plana.

create table if not exists public.message_template_groups (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 60),
  -- Mesma unidade de `message_templates.ordem` (0729): a posição nasce do
  -- VIZINHO, e a média entre duas vizinhas só precisa caber em `numeric`.
  ordem           numeric not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Alvo da FK composta que vem abaixo: o par (organização, grupo) é o que a
  -- resposta rápida referencia.
  unique (organization_id, id)
);

create unique index if not exists message_template_groups_org_name_unique
  on public.message_template_groups (organization_id, lower(btrim(name)));

-- O caminho da leitura: a tela lista os grupos da organização na ordem da
-- exibição. O índice do nome único não serve para ordenar.
create index if not exists idx_message_template_groups_org_ordem
  on public.message_template_groups (organization_id, ordem);

alter table public.message_template_groups enable row level security;

-- Privilégio EXPLÍCITO: tabela nova em `public` não herda o grant da tabela
-- vizinha, e sem esta linha `authenticated` perde select/insert/update/delete.
-- `anon` fica sem privilégio nenhum — a policy abaixo nem é avaliada para ele.
revoke all on public.message_template_groups from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.message_template_groups to authenticated;
grant select, insert, update, delete on public.message_template_groups to service_role;

drop policy if exists message_template_groups_select on public.message_template_groups;
create policy message_template_groups_select on public.message_template_groups
  for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin());

-- Escrita por `manager+`: o grupo é estrutura COMPARTILHADA da organização (a
-- mesma régua da resposta rápida com `owner_user_id` nulo). `agent` lê e
-- vincula a própria resposta a um grupo existente, mas não cria, renomeia,
-- reordena nem apaga a estrutura da equipe.
drop policy if exists message_template_groups_write on public.message_template_groups;
create policy message_template_groups_write on public.message_template_groups
  for all to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
  );

-- A coluna do vínculo nasce NULÁVEL: `null` = "sem grupo", que é a lista plana
-- de hoje. O guarda medida o NASCIMENTO da coluna (não o conteúdo), então
-- reaplicar não reescreve vínculo nenhum.
do $grupo_id$
begin
  if to_regclass('public.message_template_groups') is null
     or to_regclass('public.message_templates') is null then
    return;
  end if;

  alter table public.message_templates
    add column if not exists grupo_id uuid;
end
$grupo_id$;

-- A FK composta: o par (organização, grupo) tem de existir do outro lado.
-- `drop` antes do `add` porque `add constraint` não é idempotente, e num clone
-- que já tem a constraint a versão vigente é esta.
do $vinculo$
begin
  if to_regclass('public.message_template_groups') is null
     or to_regclass('public.message_templates') is null
     or not exists (
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'message_templates'
          and column_name = 'grupo_id'
     ) then
    return;
  end if;

  alter table public.message_templates
    drop constraint if exists message_templates_grupo_fkey;

  alter table public.message_templates
    add constraint message_templates_grupo_fkey
    foreign key (organization_id, grupo_id)
    references public.message_template_groups (organization_id, id)
    on delete set null (grupo_id);
end
$vinculo$;

-- O `on delete set null` da FK varre as respostas do grupo apagado: sem este
-- índice, apagar um grupo faz seq scan em `message_templates`.
create index if not exists idx_message_templates_grupo
  on public.message_templates (grupo_id);

-- Os comentários ficam DENTRO da guarda: `comment on column` de coluna que não
-- existe é erro fatal, e `update.sh` roda sem `ON_ERROR_STOP` — o comentário
-- falharia calado num clone cuja tabela ainda não nasceu.
do $comentarios$
begin
  if to_regclass('public.message_template_groups') is not null then
    comment on table public.message_template_groups is
      'Grupos OPCIONAIS de respostas rápidas (#3245, migration 0808). Nome único por organização (lower/btrim). Sem grupo, a tela e o Inbox mostram a lista plana de sempre. Escrita por manager+; leitura por qualquer membro.';
    comment on column public.message_template_groups.name is
      'Nome do grupo como a equipe o lê ("Atendimento inicial", "Negociação"). Único por organização sem diferenciar caixa nem espaço.';
    comment on column public.message_template_groups.ordem is
      'Posição do grupo na exibição, fracionária como message_templates.ordem (0729): reordenar grava a média entre as vizinhas e não renumera a lista.';
  end if;

  if to_regclass('public.message_templates') is not null
     and exists (
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'message_templates'
          and column_name = 'grupo_id'
     ) then
    comment on column public.message_templates.grupo_id is
      'Grupo OPCIONAL da resposta rápida (#3245, migration 0808). NULL = sem grupo: a resposta aparece na lista plana de sempre. FK composta (organization_id, grupo_id); apagar o grupo devolve a resposta a "sem grupo", nunca a apaga.';
  end if;
end
$comentarios$;

notify pgrst, 'reload schema';
