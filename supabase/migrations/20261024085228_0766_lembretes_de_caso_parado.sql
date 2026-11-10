-- manifest: **Lembrete de caso parado com relógio por espera e cadência da organização (#2584, parte i, de @Atlasads).** `organizations` ganha `lembrete_caso_ligado` (default true), `lembrete_caso_intervalo_horas` (default 24, CHECK 1..168) e `lembrete_caso_teto` (default 3, CHECK 1..10): o default é o comportamento que o `case-stale-watcher` já tinha, então nenhuma instalação muda sozinha. `agent_cases` ganha `espera_desde` e `cobrancas_na_espera`, mantidos pelo gatilho `trg_caso_marca_inicio_da_espera` (toda entrada em `awaiting_human` zera o relógio e o contador da espera), e `fn_casos_parados_para_lembrar` (só `service_role`) devolve os casos vencidos. `followup_attempts` continua contando a vida inteira do caso (o Índice de Atrito lê). Backfill sem rajada: caso que já espera começa a contar em `now()` e herda os avisos já gastos. Idempotente; apêndice espelhado no `baseline.sql`, antes do bloco da varredura de anon; `MANIFEST.md` é histórico e não recebe linha.

-- 0766 — lembrete de caso parado: relógio por espera e cadência da organização.
--
-- Trabalho de @Atlasads no PR #2584 (parte dos lembretes), trazido para um PR
-- nosso a partir da `main` e reduzido ao que o vigia que já existe precisava.
--
-- ─── O defeito que isto conserta ───────────────────────────────────────────
--
-- O `case-stale-watcher` cobrava pelo `followup_attempts`, que NUNCA zera. Um
-- caso cobrado três vezes, que foi ao cliente (`awaiting_lead`) e voltou para
-- a equipe, nunca mais era lembrado: a espera nova herdava o teto da antiga.
-- E o relógio era `updated_at`, que mede "alguém mexeu na linha", não "desde
-- quando a equipe deve uma resposta".
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. Três colunas em `organizations`, com CHECK: ligado, intervalo em horas
--      e teto por espera. Coluna e não `settings` jsonb: o banco segura a
--      faixa, e a tela e o vigia leem o mesmo nome. Os defaults (ligado, 24 h,
--      3) são o comportamento de antes.
--   2. Duas colunas em `agent_cases`: `espera_desde` (quando esta espera pela
--      equipe começou) e `cobrancas_na_espera` (avisos já dados NESTA espera).
--      `followup_attempts` segue sendo o total da vida do caso, porque
--      `fn_atrito_metrics` o lê como insistência.
--   3. O gatilho que mantém as duas: toda vez que o caso ENTRA em
--      `awaiting_human` (nasce assim, ou volta do cliente), o relógio vai para
--      `now()` e o contador para zero. Gatilho e não código de aplicação: cada
--      transição de `lib/agent-engine/agent/human-cases.ts` é um UPDATE
--      próprio, e a próxima que alguém escrever esqueceria o relógio. Não faz HTTP.
--   4. `fn_casos_parados_para_lembrar(p_limite)`: o aviso N de uma espera
--      vence em `espera_desde + N × intervalo`. A conta cruza a linha do caso
--      com a da organização, e por isso mora no banco; o `LIMIT` sem ela
--      voltaria casos ainda não vencidos e esconderia os vencidos atrás deles.
--
-- ─── Sem rajada na atualização ─────────────────────────────────────────────
--
-- O caso que JÁ espera a equipe quando esta migration roda começa a contar em
-- `now()` (e não pelo último `lead_provided`, que dispararia de uma vez todos
-- os avisos atrasados) e herda os avisos que já recebeu: quem já atingiu o
-- teto não é cobrado de novo nesta espera. O `where espera_desde is null`
-- torna o backfill seguro para o `update.sh`, que re-aplica o arquivo.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `add column if not exists`; as duas CHECK trocadas dentro de um bloco DO
-- (com o `update.sh` sem ON_ERROR_STOP, `drop` e `add` soltos deixariam a
-- coluna sem guarda se o `add` falhasse); `create or replace function`;
-- `drop trigger if exists` + `create trigger`.

alter table public.organizations
  add column if not exists lembrete_caso_ligado boolean not null default true,
  add column if not exists lembrete_caso_intervalo_horas smallint not null default 24,
  add column if not exists lembrete_caso_teto smallint not null default 3;

do $$
begin
  alter table public.organizations drop constraint if exists organizations_lembrete_caso_intervalo_check;
  alter table public.organizations add constraint organizations_lembrete_caso_intervalo_check
    check (lembrete_caso_intervalo_horas between 1 and 168);
  alter table public.organizations drop constraint if exists organizations_lembrete_caso_teto_check;
  alter table public.organizations add constraint organizations_lembrete_caso_teto_check
    check (lembrete_caso_teto between 1 and 10);
end
$$;

comment on column public.organizations.lembrete_caso_ligado is
  'Se a Central lembra a equipe do caso que espera uma decisão (case-stale-watcher). Default true: o comportamento de antes da 0766.';
comment on column public.organizations.lembrete_caso_intervalo_horas is
  'Horas entre o início da espera e cada lembrete: o aviso N vence em espera_desde + N × intervalo. Default 24.';
comment on column public.organizations.lembrete_caso_teto is
  'Quantos lembretes cada espera recebe no máximo. Default 3.';

alter table public.agent_cases
  add column if not exists espera_desde timestamptz,
  add column if not exists cobrancas_na_espera smallint not null default 0;

comment on column public.agent_cases.espera_desde is
  'Quando a espera atual pela equipe começou (o caso entrou em awaiting_human). Mantido por trg_caso_marca_inicio_da_espera.';
comment on column public.agent_cases.cobrancas_na_espera is
  'Lembretes dados nesta espera. Volta a zero quando o caso volta para a equipe; followup_attempts é o total da vida do caso.';

-- Sem rajada: quem já espera conta a partir de agora, com o que já gastou.
update public.agent_cases
   set espera_desde = now(),
       cobrancas_na_espera = followup_attempts
 where status = 'awaiting_human'
   and espera_desde is null;

create or replace function public.fn_caso_marca_inicio_da_espera()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'awaiting_human'
     and (tg_op = 'INSERT' or old.status is distinct from 'awaiting_human') then
    new.espera_desde := now();
    new.cobrancas_na_espera := 0;
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_caso_marca_inicio_da_espera() from public, anon, authenticated;

drop trigger if exists trg_caso_marca_inicio_da_espera on public.agent_cases;
create trigger trg_caso_marca_inicio_da_espera
  before insert or update of status on public.agent_cases
  for each row execute function public.fn_caso_marca_inicio_da_espera();

create or replace function public.fn_casos_parados_para_lembrar(p_limite integer default 200)
returns table (
  id uuid,
  organization_id uuid,
  title text,
  opened_at timestamptz,
  followup_attempts smallint,
  cobrancas_na_espera smallint,
  teto smallint
)
language sql
stable
set search_path = public
as $$
  select c.id, c.organization_id, c.title, c.opened_at, c.followup_attempts,
         c.cobrancas_na_espera, o.lembrete_caso_teto
    from public.agent_cases c
    join public.organizations o on o.id = c.organization_id
   where c.status = 'awaiting_human'
     and o.lembrete_caso_ligado
     and c.cobrancas_na_espera < o.lembrete_caso_teto
     and c.espera_desde <= now()
           - make_interval(hours => o.lembrete_caso_intervalo_horas * (c.cobrancas_na_espera + 1))
   order by c.espera_desde
   limit greatest(1, least(coalesce(p_limite, 200), 1000));
$$;

revoke execute on function public.fn_casos_parados_para_lembrar(integer) from public, anon, authenticated;
grant execute on function public.fn_casos_parados_para_lembrar(integer) to service_role;

notify pgrst, 'reload schema';
