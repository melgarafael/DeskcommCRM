-- manifest: **Ouvidoria como módulo provisionado (ADR-0002 D2/D3/D4/D5) — fatia 1 da #3611.** Cria `public.fn_ouvidoria_provisionar()`, sem parâmetro e com EXECUTE só de `service_role`, que cria `ouvidoria_manifestacoes` (protocolo gerado no servidor, único por organização; leitura só de `admin` da própria organização; escrita só de `service_role`; nada aponta para `crm_leads`) e chama `fn_proteger_modulo_provisionado()` na mesma transação. Quem não instala o módulo não carrega a tabela; a ativação por empresa mora em `organizations.settings.ouvidoria`. Nenhuma tabela é criada fora da provisionadora e não há backfill em `modulos_instalados`: a tabela nunca existiu fora dela numa instalação real. Idempotente; espelho no apêndice do `baseline.sql`, antes da VARREDURA anon.

-- ---- ouvidoria: a manifestação registrada vira módulo provisionado (migration 9040, #3611) ----

-- ─── O que esta tabela é ────────────────────────────────────────────────────
--
-- O relato que uma pessoa faz À EMPRESA (reclamação, denúncia, elogio,
-- sugestão) e que precisa de PROTOCOLO próprio para ser respondido — não é
-- oportunidade de venda e não pode virar cartão no funil. Nada de coluna, FK,
-- índice ou gatilho desta tabela aponta para `crm_leads`. A ATIVAÇÃO é
-- preferência da empresa e mora em `organizations.settings.ouvidoria`; a
-- MANIFESTAÇÃO é tabela, porque jsonb não dá unicidade, RLS por linha nem
-- índice de data.
--
-- ─── O protocolo é do SERVIDOR, por duas cercas ─────────────────────────────
--
-- 1. O CHECK só admite a forma que `lib/ouvidoria/registro.ts` emite
--    (`OUV-AAAAMMDD-XXXXXXXX`, 8 dígitos hexadecimais maiúsculos): protocolo
--    digitado à mão é recusado pelo banco, não só ignorado pela camada de cima.
-- 2. O índice único é POR ORGANIZAÇÃO (`organization_id, protocolo`).
--
-- ─── Por que `contact_id` e não nome/telefone em texto ──────────────────────
--
-- O contato é OPCIONAL e, quando existe, é uma referência ao CRM com
-- `on delete set null`: anonimizar a pessoa preserva a manifestação e o
-- protocolo. A decisão de LGPD está em
-- `tests/invariants/lgpd-redact-unificado-alcanca-pelo-catalogo.test.ts`.
--
-- ─── Corte de 30/10/2026 ────────────────────────────────────────────────────
--
-- A partir de 30/10 a Supabase deixa de conceder privilégios de TABELA NOVA em
-- `public` a `anon`/`authenticated`/`service_role`. Por isso os `grant` dentro
-- da provisionadora são explícitos: `authenticated` recebe SÓ `select`, e a
-- escrita é do `service_role`.

-- ── A FUNÇÃO ────────────────────────────────────────────────────────────────
-- Molde: `fn_honorarios_provisionar` (migration 0480) e `fn_financeiro_provisionar`
-- (migration 0619). Três regras da D4: sem parâmetro; security definer com
-- EXECUTE só de service_role nas DUAS origens de grant; o corpo não escreve fora
-- do módulo — só cria a tabela e chama fn_proteger_modulo_provisionado().

create or replace function public.fn_ouvidoria_provisionar()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $f$
begin
  create table if not exists public.ouvidoria_manifestacoes (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
    protocolo text not null
      check (protocolo ~ '^OUV-[0-9]{8}-[0-9A-F]{8}$'),
    canal text not null
      check (canal in ('whatsapp', 'web', 'email', 'telefone', 'presencial', 'outro')),
    texto text not null
      check (char_length(btrim(texto)) between 1 and 20000),
    contact_id uuid references public.contacts(id) on delete set null,
    status text not null default 'recebida'
      check (status in ('recebida', 'em_analise', 'concluida')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create unique index if not exists ouvidoria_manifestacoes_protocolo_org_idx
    on public.ouvidoria_manifestacoes (organization_id, protocolo);
  create index if not exists ouvidoria_manifestacoes_org_created_idx
    on public.ouvidoria_manifestacoes (organization_id, created_at desc);
  create index if not exists ouvidoria_manifestacoes_contact_idx
    on public.ouvidoria_manifestacoes (contact_id)
    where contact_id is not null;

  alter table public.ouvidoria_manifestacoes enable row level security;

  drop policy if exists ouvidoria_manifestacoes_admin_select on public.ouvidoria_manifestacoes;
  create policy ouvidoria_manifestacoes_admin_select
    on public.ouvidoria_manifestacoes
    for select using (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
    );

  revoke all on public.ouvidoria_manifestacoes from public, anon, authenticated;
  grant select on public.ouvidoria_manifestacoes to authenticated;
  grant all on public.ouvidoria_manifestacoes to service_role;

  do $c$
  begin
    if to_regclass('public.ouvidoria_manifestacoes') is not null then
      comment on column public.ouvidoria_manifestacoes.protocolo is
        'Protocolo da manifestação, GERADO NO SERVIDOR (lib/ouvidoria/registro.ts) — nunca aceito do cliente. Único POR ORGANIZAÇÃO (índice ouvidoria_manifestacoes_protocolo_org_idx); a forma OUV-AAAAMMDD-XXXXXXXX é cobrada pelo CHECK da coluna (9040).';
      comment on column public.ouvidoria_manifestacoes.contact_id is
        'Contato do CRM que relatou, OPCIONAL. on delete set null: apagar ou anonimizar a pessoa NÃO apaga a manifestação nem o protocolo (decisão escrita no catálogo LGPD dos invariantes).';
      comment on column public.ouvidoria_manifestacoes.status is
        'recebida -> em_analise -> concluida. A transição é da tela de gestão (fatia seguinte); esta fatia só grava o estado inicial.';
    end if;
  end
  $c$;

  -- D5: RLS já ligada por nós; a rotina aplica as travas de suporte na mesma transação.
  perform public.fn_proteger_modulo_provisionado();
end;
$f$;

revoke execute on function public.fn_ouvidoria_provisionar() from public, anon, authenticated;
grant execute on function public.fn_ouvidoria_provisionar() to service_role;

comment on function public.fn_ouvidoria_provisionar() is
  'Provisiona o schema do módulo de Ouvidoria (ADR-0002 D2): a tabela ouvidoria_manifestacoes, que sai do baseline e nasce na instalação do módulo. Sem parâmetro e com EXECUTE só de service_role (D4); termina em fn_proteger_modulo_provisionado() para a tabela nascer protegida na mesma transação (D5).';
