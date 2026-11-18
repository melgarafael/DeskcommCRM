-- manifest: **As identidades de rede social do contato (Instagram e Facebook) ganham tabela própria, e a ingestão das redes passa a gravá-las e a procurar a ficha por elas (issue #3764, fatia 1; contribuição de @webtecnica no PR #3837).** Tabela tenant-aware nova `contact_identities` (`organization_id`, `contact_id`, `canal`, `identificador`, `criado_em`), com `canal in ('instagram','facebook')`, `unique (organization_id, canal, identificador)`, RLS (leitura por organização, escrita a partir de `agent`) e grants próprios. Telefone e e-mail ficam FORA de propósito: já têm guarda única por organização (`contacts.phone_number` + `contact_phones`, `contacts.email_normalized`), e uma segunda cópia aqui não teria fonte declarada nem sincronia. `fn_identificador_canonico(canal, valor)` é a régua da forma gravada (perfil sem URL, sem o `@` da frente e em minúsculas; o id numérico que a rede entrega na DM passa intacto), e `fn_identidades_do_contato_canonica` aplica a régua e confere o tenant e a vida do contato em todo `insert`/`update`. O que muda no produto: a ficha VENCEDORA de uma fusão passa a receber a DM nova de uma identidade da ficha absorvida — `fn_mesclar_contatos` reponta `contact_identities.contact_id` pelo catálogo, e `contacts.social_identity` (um por ficha) só era herdado quando a vencedora não tinha o seu. Carga inicial a partir de `contacts.social_identity` (`<rede>:<conta>:<participante>`): a ficha viva leva a sua, e a lápide de uma fusão antiga entrega a dela à vencedora — o que cura as fusões que já perderam a identidade. LGPD: a virada de `is_anonymized` apaga as identidades (`trg_identidades_do_contato_anonimizado`), pela porta única da 0391. Espelho no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (cria função). Prova: `lib/contacts/identidades.test.ts`, `lib/channels/zernio/ingest-identidade-social.test.ts`, `tests/invariants/identidades-do-contato.test.ts` e `tests/invariants/identidades-do-contato-canonico-paridade.test.ts`. Fora desta fatia: sugestão de vínculo na tela, feed único por contato, resposta pelo canal escolhido, IA com histórico unificado e carteira por cliente (itens 2 a 5 da issue).
--
-- 9419 — a mesma pessoa em mais de uma rede social, e a fusão que não perde nenhuma.
--
-- ─── O problema ─────────────────────────────────────────────────────────────
--
-- A ficha guarda UMA identidade social: `contacts.social_identity`
-- (`<rede>:<conta>:<participante>`), e é por ela que a ingestão das redes acha a
-- ficha de quem escreveu na DM. Juntar duas fichas que têm cada uma a sua
-- (o Instagram de uma, o Facebook da outra) deixa a da absorvida na lápide —
-- `fn_mesclar_contatos` só a herda quando a vencedora não tem nenhuma. Na
-- próxima conversa daquela identidade, a ingestão não acha ficha viva e cria
-- uma nova: a duplicata que a fusão acabou de desfazer volta a nascer.
--
-- ─── A decisão ──────────────────────────────────────────────────────────────
--
-- Uma tabela por IDENTIDADE, não uma coluna por rede. Colunas por rede fecham o
-- vocabulário na migration: a terceira rede pediria `alter table` em
-- `contacts`, e o índice de unicidade teria de ser escrito uma vez por coluna.
-- Aqui a rede é dado (`canal`), a unicidade é uma só e o mesmo par
-- `(canal, identificador)` nunca aponta para duas fichas da MESMA organização.
-- Como `contact_id` é FK para `contacts`, `fn_mesclar_contatos` (0215) reponta a
-- linha pelo catálogo, sem lista à mão — e a ficha vencedora passa a ter as
-- identidades das duas.
--
-- Só Instagram e Facebook. Telefone e e-mail já têm guarda única por
-- organização (`contacts.phone_number` + `contact_phones` da 9043,
-- `contacts.email_normalized`), e uma segunda cópia aqui seria duas fontes sem
-- sincronia. Acrescentar uma rede é acrescentar no CHECK, na régua e em
-- `CANAIS_DE_IDENTIDADE` (`lib/contacts/identidades.ts`), na mesma entrega.
--
-- O identificador é gravado SEMPRE na forma canônica, e é o banco que garante:
-- `fn_identificador_canonico` normaliza e a constraint
-- `contact_identities_identificador_canonico` recusa o que não estiver nela.
--
-- ─── O que NÃO faz ──────────────────────────────────────────────────────────
--
-- 1. **Não funde ficha nenhuma.** A junção continua sendo `fn_mesclar_contatos`.
--    Como o unique é por ORGANIZAÇÃO, duas fichas da mesma organização nunca
--    têm o mesmo par, então o repontamento não pode colidir.
-- 2. **Não mexe no feed, no envio, nem na IA.** Aquilo é o resto da #3764.
--
-- Idempotente: `create ... if not exists`, `drop constraint if exists` + `add`,
-- `create or replace`, `drop trigger if exists` + `create`.

-- ── 1. A régua da forma gravada ─────────────────────────────────────────────
-- O que a ingestão grava é o id do participante que a rede entrega na DM
-- (numérico); o que um atendente colaria é o perfil (`@fulano`, a URL). A régua
-- aceita os dois e devolve a mesma forma que `normalizarIdentificador`
-- (`lib/contacts/identidades.ts`) — a concordância é medida caso a caso em
-- `tests/invariants/identidades-do-contato-canonico-paridade.test.ts`.
--
-- `immutable` e `search_path` vazio: entra numa constraint, e constraint
-- reconstruída por `pg_restore` não enxerga o `search_path` de ninguém.
create or replace function public.fn_identificador_canonico(p_canal text, p_valor text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  with perfil as (
    select nullif(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(btrim(coalesce(p_valor, ''))), '^https?://', ''),
            '^(www\.|m\.)?(instagram\.com|facebook\.com|fb\.com|fb\.me)/', ''),
          '[?#].*$', ''),
        '/+$', ''),
      '') as v
  ),
  -- Só o `@` da FRENTE sai: `fulano@` não é perfil, e a lib também o recusa.
  limpo as (select nullif(regexp_replace(perfil.v, '^@+', ''), '') as v from perfil)
  select case
    when p_canal = 'instagram' then
      case when l.v ~ '^[a-z0-9._]{1,30}$' and l.v !~ '^\.+$' then l.v else null end
    when p_canal = 'facebook' then
      case when l.v ~ '^[a-z0-9._-]{1,64}$' then l.v else null end
    else null
  end
  from limpo l;
$$;

revoke execute on function public.fn_identificador_canonico(text, text) from public, anon;
grant execute on function public.fn_identificador_canonico(text, text) to authenticated, service_role;

-- ── 2. A tabela ─────────────────────────────────────────────────────────────
-- `criado_em` (e não `created_at`) é o nome pedido na issue; as tabelas
-- vizinhas usam `created_at`, e o mapeamento mora no leitor, não numa coluna
-- com dois nomes.
create table if not exists public.contact_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  canal text not null,
  identificador text not null,
  criado_em timestamptz not null default now()
);

alter table public.contact_identities drop constraint if exists contact_identities_canal_check;
alter table public.contact_identities add constraint contact_identities_canal_check
  check (canal in ('instagram', 'facebook'));

-- O identificador gravado É a forma canônica do canal. A constraint é a segunda
-- cerca (a primeira é o gatilho da seção 3): banco que já tem a linha recusa a
-- variante mesmo vindo de escrita direta.
alter table public.contact_identities drop constraint if exists contact_identities_identificador_canonico;
alter table public.contact_identities add constraint contact_identities_identificador_canonico
  check (
    identificador = public.fn_identificador_canonico(canal, identificador)
    and char_length(identificador) between 1 and 320
  );

-- Um par `(canal, identificador)` aponta para UMA ficha da organização. É o
-- índice que a ingestão consulta para achar a ficha de quem escreveu.
create unique index if not exists uniq_contact_identities_org_canal_identificador
  on public.contact_identities (organization_id, canal, identificador);

-- "Que identidades tem esta ficha" — o export do titular e o repontamento da
-- fusão (que procura por `contact_id`).
create index if not exists idx_contact_identities_contato
  on public.contact_identities (organization_id, contact_id);

alter table public.contact_identities enable row level security;

-- Leitura para todo membro da organização; escrita a partir de `agent`, o mesmo
-- piso do PATCH de contato e de `contact_phones` (9043). Policy `for all` só de
-- tenancy é a dívida que a 0150 congelou: num `viewer` falando direto com o
-- PostgREST, ele trocaria a identidade de uma ficha.
drop policy if exists tenant_isolation_contact_identities_read on public.contact_identities;
create policy tenant_isolation_contact_identities_read on public.contact_identities
  for select
  using (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_contact_identities_write on public.contact_identities;
create policy tenant_isolation_contact_identities_write on public.contact_identities
  for all
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'agent'))
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'agent'));

-- Grant próprio: desde 30/10/2026 o default ACL de `public` nasce revogado
-- (migration 9037), então tabela sem bloco de grant responde `42501` pela Data
-- API. `anon` fica de fora — não há leitura pública de identidade de cliente.
do $grants_contact_identities$
begin
  revoke all on table public.contact_identities from anon, authenticated, service_role;
  grant select, insert, update, delete on table public.contact_identities to authenticated, service_role;
end
$grants_contact_identities$;

-- ── 3. A gravação: forma canônica e tenant do contato ───────────────────────
-- `security definer` porque a conferência LÊ `contacts` — sob RLS de quem
-- chama, o contato de outra organização apareceria como inexistente e a recusa
-- seria a errada. `search_path` vazio e EXECUTE revogado: só o gatilho chama.
create or replace function public.fn_identidades_do_contato_canonica()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contato record;
begin
  new.identificador := public.fn_identificador_canonico(new.canal, new.identificador);
  if new.identificador is null then
    raise exception using errcode = '23502', message = 'identidade_vazia';
  end if;

  -- A ficha é da MESMA organização e está viva. Sem isto, uma linha com o
  -- `organization_id` de A e o contato de B passaria pela RLS de A.
  select c.organization_id, c.is_merged_into, c.is_anonymized into v_contato
    from public.contacts c where c.id = new.contact_id;
  if not found or v_contato.organization_id <> new.organization_id then
    raise exception using errcode = '23503', message = 'identidade_de_outra_organizacao';
  end if;
  if v_contato.is_merged_into is not null or v_contato.is_anonymized then
    raise exception using errcode = 'P0002', message = 'identidade_de_ficha_indisponivel';
  end if;

  -- `criado_em` é carimbo de nascimento, não de edição: `update` preserva.
  if tg_op = 'INSERT' then
    new.criado_em := now();
  else
    new.criado_em := old.criado_em;
  end if;

  return new;
end;
$$;

revoke all on function public.fn_identidades_do_contato_canonica() from public;
revoke execute on function public.fn_identidades_do_contato_canonica() from anon, authenticated;

drop trigger if exists trg_identidades_do_contato_canonica on public.contact_identities;
create trigger trg_identidades_do_contato_canonica
  before insert or update on public.contact_identities
  for each row execute function public.fn_identidades_do_contato_canonica();

-- ── 4. LGPD: anonimizar apaga as identidades ────────────────────────────────
-- Perfil social não tem versão anonimizada que ainda sirva (o mesmo critério
-- do passo 1b de `contact_phones` na cascata). A porta é a virada de
-- `is_anonymized` em `contacts` — o mesmo desenho da 0391, que é por onde
-- passam os DOIS caminhos de anonimização (a cascata e
-- `fn_lgpd_anonymize_contact`), então não há caminho que escape por construção.
-- `after` e `return null`: gatilho de linha `after` não altera a linha do
-- evento, e devolver `new` aqui sugeriria que altera.
create or replace function public.fn_identidades_do_contato_anonimizado()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_anonymized and not coalesce(old.is_anonymized, false) then
    delete from public.contact_identities
     where organization_id = new.organization_id
       and contact_id = new.id;
  end if;
  return null;
end;
$$;

revoke all on function public.fn_identidades_do_contato_anonimizado() from public;
revoke execute on function public.fn_identidades_do_contato_anonimizado() from anon, authenticated;

drop trigger if exists trg_identidades_do_contato_anonimizado on public.contacts;
create trigger trg_identidades_do_contato_anonimizado
  after update of is_anonymized on public.contacts
  for each row execute function public.fn_identidades_do_contato_anonimizado();

-- ── 5. As fichas que já existem ─────────────────────────────────────────────
-- A carga inicial sai de `contacts.social_identity`, que a ingestão grava como
-- `<rede>:<conta>:<participante>` desde que as redes existem. Duas fontes:
--
--   a ficha VIVA entrega a sua identidade a si mesma, e
--   a LÁPIDE de uma fusão (`is_merged_into`) entrega a dela à vencedora — é a
--   identidade que a herança por `coalesce` deixou para trás, e é isto que cura
--   as fusões feitas antes desta migration.
--
-- Fica de fora o que o gatilho da seção 3 recusaria (ficha de destino
-- anonimizada ou ela mesma mesclada, identificador fora da régua), porque uma
-- recusa derrubaria o `insert` inteiro. A identidade de uma ficha anonimizada
-- também não entra pela lápide. Entre duas fontes para o mesmo par vence a ficha
-- viva, depois a mais antiga. Idempotente pelo `on conflict do nothing`.
insert into public.contact_identities (organization_id, contact_id, canal, identificador)
select distinct on (o.organization_id, o.canal, o.identificador)
       o.organization_id, o.contact_id, o.canal, o.identificador
  from (
    select c.organization_id,
           coalesce(c.is_merged_into, c.id) as contact_id,
           split_part(c.social_identity, ':', 1) as canal,
           public.fn_identificador_canonico(
             split_part(c.social_identity, ':', 1),
             regexp_replace(c.social_identity, '^.*:', '')
           ) as identificador,
           c.is_merged_into is null as viva,
           c.created_at,
           c.id
      from public.contacts c
     where c.social_identity ~ '^(instagram|facebook):.+:.+$'
       and not coalesce(c.is_anonymized, false)
  ) o
  join public.contacts dono
    on dono.id = o.contact_id
   and dono.organization_id = o.organization_id
   and dono.is_merged_into is null
   and not coalesce(dono.is_anonymized, false)
 where o.identificador is not null
 order by o.organization_id, o.canal, o.identificador, o.viva desc, o.created_at, o.id
on conflict (organization_id, canal, identificador) do nothing;
