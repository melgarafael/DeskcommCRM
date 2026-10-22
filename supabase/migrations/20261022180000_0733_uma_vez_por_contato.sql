-- manifest: Execuções de automação ganham `contact_id` (uuid, FK para `contacts` com `on delete set null`) e o índice por regra e contato — é o que deixa a opção "no máximo uma vez por contato" (#2974) decidir pelo ESTADO PERSISTIDO, sobrevivendo a reinício do worker.
--
-- ─── O que isto resolve ─────────────────────────────────────────────────────
-- O motor (`lib/automation/engine.ts`) dispara TODA regra que casa em TODO
-- evento que casa: o lead que volta pelo mesmo anúncio recebe a sequência
-- inteira outra vez (várias fotos + textos repetidos na mesma conversa, que
-- parece robô quebrado e ainda aumenta o volume automático no número). Não
-- havia como evitar isso por regra: `automation_rule_runs` não guardava o
-- contato, então nem existia onde contar execuções por contato.
--
-- A coluna nasce NULLABLE e SEM BACKFILL: as linhas antigas não têm como saber
-- de que contato eram — o evento é a única fonte, e nem todo evento traz um
-- contato resolvível. NULL = desconhecido, e desconhecido é FAIL-OPEN no motor
-- (a regra segue como sempre foi; calar por falta de leitura esconderia
-- automação legítima).
--
-- ─── Por que `on delete set null` ───────────────────────────────────────────
-- A linha de execução é registro histórico (auditoria do que a automação fez).
-- O mesmo desenho de `event_id`: expurgar/anonimizar o contato não pode apagar
-- o registro da execução nem ser impedido por ele.
--
-- ─── O índice ───────────────────────────────────────────────────────────────
-- A pergunta do motor é "esta regra já rodou para ESTE contato?", sempre com
-- `organization_id` no filtro (doutrina multi-tenant), então o índice é
-- `(organization_id, rule_id, contact_id)` e PARCIAL (`contact_id is not null`):
-- a linha antiga sem contato não entra nele, e ele não cresce junto com o
-- histórico que o backfill (declarado FORA desta fatia) ainda não cobriu.
--
-- Aditiva e idempotente: `add column if not exists` + `create index if not
-- exists`. Nada é reescrito, nada a corrigir antes de aplicar.

alter table public.automation_rule_runs
  add column if not exists contact_id uuid references public.contacts(id) on delete set null;

create index if not exists idx_automation_rule_runs_org_regra_contato
  on public.automation_rule_runs (organization_id, rule_id, contact_id)
  where contact_id is not null;

comment on column public.automation_rule_runs.contact_id is
  'Contato desta execução, quando o evento deixou resolvê-lo. NULL = não resolvível (linha anterior a esta migration, ou evento sem contato) e NULL é fail-open para a opção "no máximo uma vez por contato" (#2974). on delete set null: o registro da execução sobrevive ao expurgo do contato.';

notify pgrst, 'reload schema';
