-- manifest: **As identidades do contato (WhatsApp, Instagram, Facebook e e-mail) ganham tabela própria, para que a mesma pessoa seja reconhecida por mais de um caminho (issue #3764, fatia 1).** Tabela tenant-aware nova `contact_identities` (`organization_id`, `contact_id`, `canal`, `identificador`, `criado_em`), com `canal in ('whatsapp','instagram','facebook','email')`, `unique (organization_id, canal, identificador)`, RLS (leitura por organização, escrita a partir de `agent`) e grants próprios. `fn_identificador_canonico(canal, valor)` é a régua ÚNICA da forma gravada — telefone em E.164 pela `fn_telefone_canonico` (9043) mais a decisão de forma que ela não dá (`+55` implícito no número nacional e guarda de 8–15 dígitos, a mesma régua de `normalizePhoneBR`), e-mail em minúsculas, perfil social sem o `@` da frente e em minúsculas —, e `fn_identidades_do_contato_canonica` aplica a régua e confere o tenant do contato em todo `insert`/`update`: sem isso `+55 31 9…` e `+55319…` seriam duas identidades e o índice não seguraria nada. LGPD: a virada de `is_anonymized` apaga as identidades do contato (`trg_identidades_do_contato_anonimizado`), no mesmo desenho de porta única da 0391 — telefone, e-mail e perfil social não têm versão anonimizada que ainda sirva. Espelho no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (cria função). Prova: `lib/contacts/identidades.test.ts` (biblioteca pura) e `tests/invariants/identidades-do-contato.test.ts` (unique, forma canônica, RLS e anonimização). Fora desta fatia, declarado na issue: feed único por contato no Inbox, resposta pelo canal escolhido com janela de 24 h, IA com histórico unificado e atribuição/carteira por cliente (itens 2 a 5).
--
-- 9082 — a mesma pessoa em mais de um caminho: WhatsApp, Instagram, Facebook e e-mail.
--
-- ─── O problema ─────────────────────────────────────────────────────────────
--
-- O contato guarda o canal de forma CHAPADA: `contacts.phone_number` para o
-- WhatsApp (com os extras da 9043 em `contact_phones`) e `contacts.email` para o
-- e-mail. Instagram e Facebook não têm onde morar — o perfil social que a
-- ingestão da Zernio escreve vive dentro de `contacts.social_identity` (jsonb,
-- um por ficha), e nada liga um perfil ao outro. Quem chama no Instagram, depois
-- no Facebook e depois no WhatsApp nasce em até três fichas, e não existe
-- estrutura onde diga "estas três são a mesma pessoa".
--
-- ─── A decisão ──────────────────────────────────────────────────────────────
--
-- Uma tabela por IDENTIDADE, não uma coluna por canal. Colunas por canal fecham
-- o vocabulário na migration: a quinta rede pediria `alter table` em
-- `contacts`, e o índice de unicidade teria de ser escrito uma vez por coluna.
-- Aqui o canal é dado (`canal`), a unicidade é uma só e o mesmo par
-- `(canal, identificador)` nunca aponta para duas fichas da MESMA organização.
--
-- O identificador é gravado SEMPRE na forma canônica, e é o banco que garante:
-- `fn_identificador_canonico` normaliza e a constraint
-- `contact_identities_identificador_canonico` recusa o que não estiver nela.
-- Sem isso o unique seria decorativo — `+55 31 98966-398`, `+553198966398` e
-- `+5531998966398` são três strings e uma pessoa só.
--
-- ─── O que NÃO faz ──────────────────────────────────────────────────────────
--
-- 1. **Não preenche nada a partir das fichas que já existem.** Escrever
--    `whatsapp` para todo `phone_number` seria afirmar que aquele número TEM
--    WhatsApp (a 9043 existe justamente porque nem todo celular tem, e criou
--    `contacts.phone_whatsapp` com `nao_sei` como resposta honesta), e o perfil
--    social da Zernio não diz a que rede pertence. A tabela nasce VAZIA; a
--    identidade nasce do uso.
-- 2. **Não funde ficha nenhuma.** A junção manual continua sendo
--    `fn_mesclar_contatos` (0215), que reponta toda FK por catálogo — inclusive
--    `contact_identities.contact_id`, sem lista à mão. Como o unique é por
--    ORGANIZAÇÃO, duas fichas da mesma organização nunca têm o mesmo par
--    `(canal, identificador)`, então o repontamento não pode colidir.
-- 3. **Não mexe no feed, no envio, nem na IA.** Aquilo é o resto da #3764.
--
-- Idempotente: `create ... if not exists`, `drop constraint if exists` + `add`,
-- `create or replace`, `drop trigger if exists` + `create`.

-- ── 1. A régua da forma gravada ─────────────────────────────────────────────
-- Telefone: o nono dígito do celular brasileiro é `fn_telefone_canonico` (9043),
-- a mesma regra de `canonicalPhoneBR` (`lib/channels/phone-variants.ts`). O que
-- a 9043 NÃO responde — e esta função precisa responder — é quando o `+55` está
-- implícito: ela recebe um E.164 que o app já normalizou, e aqui chega o que a
-- pessoa digitou. Então a decisão de forma (com `+` exige 8–15 dígitos; sem `+`,
-- 12–13 têm de começar com 55 e 10–11 são DDD + número) mora AQUI, espelhando
-- `normalizePhoneBR`. A duplicação lib×SQL é a que a 9043 já aceitou e
-- documentou; a alternativa (normalizar só em TypeScript) deixaria a porta do
-- PostgREST aberta para gravar variante. As duas réguas são medidas, caso a
-- caso, em `tests/invariants/identidades-do-contato-canonico-paridade.test.ts`:
-- divergir aqui é mudo — o app procura uma string e o banco grava outra.
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
  with bruto as (
    select btrim(coalesce(p_valor, '')) as v
  ),
  digitos as (
    select regexp_replace(b.v, '\D', '', 'g') as d from bruto b
  ),
  perfil as (
    select nullif(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(btrim(v)), '^https?://', ''),
            '^(www\.|m\.)?(instagram\.com|facebook\.com|fb\.com|fb\.me)/', ''),
          '[?#].*$', ''),
        '/+$', ''),
      '') as v
    from bruto
  ),
  -- Só o `@` da FRENTE sai. `btrim(v, '@')` tirava a cauda também, e `fulano@`
  -- virava `fulano` — identidade que a lib RECUSA (`perfilDaUrl` só corta o
  -- prefixo). Divergência em valor inválido é a pior espécie: o banco grava o
  -- que a tela nunca procuraria.
  limpo as (select nullif(regexp_replace(perfil.v, '^@+', ''), '') as v from perfil)
  select case
    when b.v = '' then null

    -- ── whatsapp: a MESMA decisão de forma de `normalizePhoneBR` ────────────
    -- Delegar isso à `fn_telefone_canonico` (9043) não dá: ela é a regra do
    -- NONO DÍGITO sobre um número que JÁ é E.164 — o `contacts.phone_number` a
    -- recebe depois de o app ter normalizado. Aqui entra o que a pessoa
    -- digitou (o número do direct, o do formulário, o que o atendente colou),
    -- então a decisão de quando o `+55` está implícito mora nesta função,
    -- espelhando `lib/channels/phone-variants.ts`: com `+`, exige 8 a 15
    -- dígitos; sem `+`, 12 ou 13 dígitos têm de começar com 55, e 10 ou 11 são
    -- DDD + número brasileiro. Sem a guarda de tamanho, `123` virava `+123` e
    -- um valor mascarado (`55 31 ****-6398`) virava `+55316398` — identidade
    -- que nunca mais casa com o número real e ocupa o índice único.
    -- A concordância das duas réguas, caso a caso, é medida em
    -- `tests/invariants/identidades-do-contato-canonico-paridade.test.ts`.
    when p_canal = 'whatsapp' then
      case
        when b.v like '+%' then
          case when d.d ~ '^[0-9]{8,15}$' then public.fn_telefone_canonico(b.v) else null end
        when length(d.d) in (12, 13) then
          case when d.d like '55%' then public.fn_telefone_canonico('+' || d.d) else null end
        when length(d.d) in (10, 11) then public.fn_telefone_canonico('+55' || d.d)
        else null
      end

    -- A mesma régua de `contacts_email_format`: sem `@` e sem domínio não é
    -- e-mail, e `null` aqui vira recusa no gatilho em vez de identidade torta.
    when p_canal = 'email' then
      case when lower(b.v) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(b.v) else null end
    when p_canal = 'instagram' then
      case when l.v ~ '^[a-z0-9._]{1,30}$' and l.v !~ '^\.+$' then l.v else null end
    when p_canal = 'facebook' then
      case when l.v ~ '^[a-z0-9._-]{1,64}$' then l.v else null end
    else null
  end
  from bruto b, digitos d, limpo l;
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
  check (canal in ('whatsapp', 'instagram', 'facebook', 'email'));

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
-- coração da fatia: o mesmo e-mail, o mesmo número ou o mesmo perfil não podem
-- morar em duas fichas.
create unique index if not exists uniq_contact_identities_org_canal_identificador
  on public.contact_identities (organization_id, canal, identificador);

-- As duas leituras que a fatia seguinte vai pedir: "que identidades tem esta
-- ficha" e "quem já tem esta identidade" (a sugestão de vínculo).
create index if not exists idx_contact_identities_contato
  on public.contact_identities (organization_id, contact_id);
create index if not exists idx_contact_identities_org_canal
  on public.contact_identities (organization_id, canal);

alter table public.contact_identities enable row level security;

-- Leitura para todo membro da organização; escrita a partir de `agent`, o mesmo
-- piso do PATCH de contato e de `contact_phones` (9043). Policy `for all` só de
-- tenancy é a dívida que a 0150 congelou: num `viewer` falando direto com o
-- PostgREST, ele trocaria o e-mail de uma ficha.
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
-- Telefone, e-mail e perfil social não têm versão anonimizada que ainda sirva
-- (o mesmo critério do passo 1b de `contact_phones` na cascata). A porta é a
-- virada de `is_anonymized` em `contacts` — o mesmo desenho da 0391, que é por
-- onde passam os DOIS caminhos de anonimização (a cascata e
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
