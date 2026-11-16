-- manifest: **Negócio ganho vira recorrência no financeiro e negócio perdido desativa a dele (#3602, fatias 3 e 4).** `recurring_entries.crm_lead_id uuid` nullable, `references public.crm_leads(id) on delete set null` — o mesmo desenho das outras colunas de origem (0357), e sem cascata: apagar o negócio não apaga o molde que já explicou lançamentos pagos, só corta o vínculo. `recurring_entries_org_lead_uidx` único em (organization_id, crm_lead_id) onde `crm_lead_id is not null` põe a IDEMPOTÊNCIA no banco: entrar de novo na etapa — ou dois arrastos simultâneos — não duplica o molde. ADITIVA: nenhuma coluna existente muda, nenhuma linha é reescrita. Espelho no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (0116). Prova em `tests/invariants/recorrencia-do-negocio.test.ts`.
--
-- ─── Por que uma coluna de origem, e não uma flag ───────────────────────────────
--
-- A recorrência nasce do NEGÓCIO (o molde que o cron usa para criar as contas a
-- receber todo mês), mas a vida dela continua depois do fecho: quem desativa é a
-- perda do negócio, e quem explica o molde é o vínculo. Sem o vínculo, o molde
-- criado pelo ganho é indistinguível de um molde digitado à mão — a perda do
-- negócio não teria como achar o que desativar sem casar por nome e valor.
--
-- ─── Por que `on delete set null` ─────────────────────────────────────────────
--
-- É a regra da casa para coluna de origem (0357, `created_by_user_id`; 0341,
-- `recurring_entry_id`): o molde NUNCA é apagado em cascata, porque ele explica
-- lançamentos que já foram pagos. Apagar o negócio corta a ligação e o molde
-- segue na tela do financeiro, inativo ou não pela decisão de quem opera.
--
-- ─── Uma única recorrência por negócio ────────────────────────────────────────
--
-- O índice é ÚNICO e PARCIAL (só onde a coluna não é nula): molde digitado à mão
-- não tem negócio e pode repetir. Para o vínculo, o único é o que transforma
-- "entrar de novo na etapa não duplica" em garantia do banco em vez de leitura
-- antes da escrita — a mesma lição do `financial_entries_recorrencia_competencia_idx`
-- (0357), e o mesmo buraco que a leitura sozinha deixaria na corrida de dois
-- arrastos simultâneos.
--
-- Idempotente: `add column if not exists`, índice `if not exists`.

alter table public.recurring_entries
  add column if not exists crm_lead_id uuid
  references public.crm_leads(id) on delete set null;

create unique index if not exists recurring_entries_org_lead_uidx
  on public.recurring_entries (organization_id, crm_lead_id)
  where crm_lead_id is not null;

comment on column public.recurring_entries.crm_lead_id is
  'O negócio que originou o molde (negócio ganho com recorrência, #3602). Nullable: molde digitado à mão não tem negócio. on delete set null — o molde explica lançamentos pagos e não é apagado em cascata. Migration 9316.';
