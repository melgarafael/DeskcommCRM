-- manifest: **O molde da recorrência do negócio para no último mês do contrato (#3602, doc 312 = A).** `recurring_entries.ends_on date` nullable: a última competência que o molde ainda gera; nulo = sem prazo, o desenho de todo molde digitado à mão. O ganho do negócio grava a data a partir de `crm_leads.recurring_months`, e o cron `app/api/v1/cron/recurring-entries` pula a competência posterior a ela. Sem a coluna, um contrato de 12 meses virava conta a receber para sempre. ADITIVA: nenhuma linha é reescrita. Espelho no apêndice do `supabase/baseline.sql`, logo depois do bloco 9316. Prova em `tests/invariants/recorrencia-do-negocio.test.ts`. Também `recurring_entries.desativada_pela_perda boolean not null default false` com o gatilho `trg_recorrencia_marca_de_perda`: o re-ganho reativa só o molde que a PERDA desligou, e o que a equipe desligou à mão fica desligado.
--
-- Por que uma DATA e não o número de meses: o cron compara competência com
-- competência, e a data já carrega o dia do mês resolvido (o dia 31 que cai em
-- 30 de abril). O número de meses exigiria saber de que mês o molde partiu, e
-- o re-ganho de um negócio parte de outro mês.
--
-- Idempotente: `add column if not exists`.

alter table public.recurring_entries
  add column if not exists ends_on date;

comment on column public.recurring_entries.ends_on is
  'A última competência que o molde gera; nulo = sem prazo. Gravada pelo ganho do negócio a partir de crm_leads.recurring_months (#3602). Migration 9371.';

-- A perda marca o molde que ela desligou (conserto da triagem): o re-ganho reativa SÓ esse.
-- O re-ganho reativa SÓ o molde que a perda do negócio desativou. Um molde que
-- alguém da equipe desligou à mão (no catálogo do financeiro) fica desligado: o
-- ganho não passa por cima de decisão humana. Toda troca de is_active que não
-- venha com a marca explícita (a perda e o re-ganho a mandam) apaga a marca.
alter table public.recurring_entries
  add column if not exists desativada_pela_perda boolean not null default false;

comment on column public.recurring_entries.desativada_pela_perda is
  'true = a perda do negócio desativou este molde, e só então o re-ganho o reativa. Qualquer outra troca de is_active (a equipe no catálogo) zera a marca: o gatilho trg_recorrencia_marca_de_perda. Migration 9371.';

create or replace function public.fn_recorrencia_marca_de_perda()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_active is distinct from old.is_active
     and new.desativada_pela_perda is not distinct from old.desativada_pela_perda then
    new.desativada_pela_perda := false;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_recorrencia_marca_de_perda() from public, anon, authenticated;

drop trigger if exists trg_recorrencia_marca_de_perda on public.recurring_entries;
create trigger trg_recorrencia_marca_de_perda
  before update of is_active, desativada_pela_perda on public.recurring_entries
  for each row execute function public.fn_recorrencia_marca_de_perda();

