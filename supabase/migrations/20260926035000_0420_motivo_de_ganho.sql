-- 0420 · MOTIVO DE GANHO NATIVO (issue #1536)
--
-- O produto pedia "por que ganhamos" e não tinha onde guardar: `lost_reason`
-- existe desde sempre (CHECK `crm_leads_lost_reason_required` + trigger
-- `fn_validate_lost_reason_required`), e o ganho fechava mudo — a métrica de
-- ganho e de concorrência nascia vazia. Esta coluna é o espelho da perda, com
-- DUAS diferenças de desenho que já estão no texto do comentário:
--
-- 1 · NULLABLE E SEM CHECK. A obrigatoriedade do motivo de ganho é OPT-IN por
--     funil (`settings.won_reason_required`, decidida no servidor em
--     `lib/leads/campos-exigidos.ts`); uma CHECK no banco tornaria obrigatório
--     para TODO install, incluindo os que nunca cadastraram motivo nenhum —
--     e quebraria toda escrita de ganho existente num upgrade.
--
-- 2 · SEM FK E SEM trigger de vocabulário. A lista por funil
--     (`settings.won_reasons`) é validada em aplicação
--     (`recusaDeMotivoDoGanho`), porque não há trigger de GANHO no banco: a
--     CHECK/trigger da perda nasceu com a issue #917 e não existe irmã para o
--     ganho. Inventar uma aqui mudaria regra de escrita alheia nesta migration.
--
-- Idempotente (`add column if not exists`): o `update.sh` do clone re-executa o
-- apêndice inteiro do `baseline.sql` a cada atualização. Sem backfill — linha
-- antiga fica `null`, o mesmo "não sei por que ganhou" de hoje.
alter table public.crm_leads
  add column if not exists won_reason text;

comment on column public.crm_leads.won_reason is
  'Motivo do ganho (issue #1536, migration 0420): por que este negócio foi fechado como ganho. null quando ninguém informou. Texto livre por padrão; settings.won_reasons do funil transforma em lista e settings.won_reason_required liga a obrigatoriedade — as duas decididas no servidor (lib/leads/campos-exigidos.ts), nunca por CHECK: o ganho não tinha exigência nenhuma antes e não pode ganhar uma para o install inteiro.';
