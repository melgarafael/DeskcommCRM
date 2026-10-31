-- manifest: **Ouvidoria vira módulo provisionado (ADR-0002 D2/D3/D4/D5) — fatia 1 da #3611.** A tabela `ouvidoria_manifestacoes` sai do `baseline.sql` e passa a nascer em `public.fn_ouvidoria_provisionar()`, sem parâmetro e com EXECUTE só de `service_role`, que cria a tabela e chama `fn_proteger_modulo_provisionado()` na mesma transação. Quem não instala o módulo não carrega a tabela. A ativação por empresa continua em `organizations.settings.ouvidoria`. Quem já tinha a tabela (instalação que rodou a 9030) é marcado como módulo instalado.

-- ---- ouvidoria: a manifestação registrada vira módulo provisionado (migration 9040, #3611) ----

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
        'Protocolo da manifestação, GERADO NO SERVIDOR (lib/ouvidoria/registro.ts) — nunca aceito do cliente. Único POR ORGANIZAÇÃO (índice ouvidoria_manifestacoes_protocolo_org_idx); a forma OUV-AAAAMMDD-XXXXXXXX é cobrada pelo CHECK da coluna (9030).';
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

-- ═══ O MÓDULO QUE JÁ EXISTE VOLTA A CONSTAR COMO INSTALADO ═══════════════════
-- A tabela viveu no baseline desde a 9030: quem tem ouvidoria_manifestacoes tem
-- o módulo instalado de fato, só que sem a linha em modulos_instalados. Backfill.
insert into public.modulos_instalados (modulo, estado, instalado_por, reaplicado_em)
  select 'ouvidoria', 'ativo', null, now()
   where to_regclass('public.ouvidoria_manifestacoes') is not null
     and not exists (
       select 1 from public.modulos_instalados where modulo = 'ouvidoria'
     )
  on conflict (modulo) do nothing;
