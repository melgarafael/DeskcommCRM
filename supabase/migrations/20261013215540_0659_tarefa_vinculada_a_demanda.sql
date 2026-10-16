-- manifest: **A tarefa criada de dentro do atendimento fica presa à demanda, não nasce avulsa (#2818).** `crm_tasks` só tinha `lead_id` e `contact_id`: a tarefa combinada no meio da conversa ("te chamo amanhã") nascia sem vínculo com o ASSUNTO que a originou e não voltava à tela de quem precisa cumprir. Coluna `demanda_id uuid references public.demandas(id) on delete set null` — o MESMO `on delete set null` do `lead_id` (encerrar ou apagar a demanda não pode apagar o que a pessoa escreveu para si mesma) — com índice parcial `(demanda_id) where demanda_id is not null`. Aditiva e reversível, sem reescrita de dado; sem função e sem policy nova (a demanda ser da organização de quem grava é conferido nas rotas, em `lib/tarefas/demanda.ts`).

-- ---- a tarefa nasce presa à demanda do atendimento (migration 0659, #2818) ----
-- Hoje a tarefa tem DOIS vínculos opcionais, `lead_id` e `contact_id`, e nenhum
-- dos dois responde "de qual ATENDIMENTO veio este combinado". No meio da
-- conversa o atendente combina algo e tem dois caminhos ruins: abrir a aba
-- Tarefas (que não sabe de qual atendimento ele estava falando — a tarefa nasce
-- avulsa) ou escrever na nota da conversa (que é texto: sem prazo, responsável
-- nem situação, não entra na lista de abertas e não lembra ninguém). Em ambos o
-- combinado morre, porque ele não volta para a tela de quem precisa cumprir.
--
-- O vínculo é a DEMANDA, não a conversa direta (a opção A, preferida na
-- proposta da #2818). A conversa já é atravessada pela demanda (`conversations.current_demanda_id`
-- e a ponte `demanda_conversas`), e uma FK direta na conversa morreria com ela
-- (cascade) — perderia o histórico do combinado. A demanda é a unidade de
-- ATENDIMENTO: sobrevive à conversa pontual, e para o caso de uma conversa sem
-- demanda o `contact_id` (já suportado) cobre.
--
-- `on delete set null` e não `cascade`, pelo mesmo motivo escrito no `lead_id`
-- (migration 0210): apagar o assunto do atendimento não pode apagar o lembrete
-- que a pessoa escreveu para si mesma. A tarefa continua na lista, com o vínculo
-- zerado — nada some da tela de quem ainda tem o que fazer.
--
-- Sem RLS nova: a policy de `crm_tasks` isola por `organization_id`. A FK só
-- garante que a demanda apontada existe; que ela é da organização de quem grava
-- é conferido nas rotas de criar e editar, em `lib/tarefas/demanda.ts`. Sem
-- trigger. Idempotente (`add column if not exists`, `create index if not
-- exists`), re-aplicável pelo `update.sh` de um clone.

alter table public.crm_tasks
  add column if not exists demanda_id uuid references public.demandas(id) on delete set null;

-- As tarefas de UMA demanda, para a seção "Tarefas desta demanda" do inbox.
-- Parcial porque a maioria das linhas não tem demanda (a tarefa avulsa é caso
-- real) — indexar NULL aqui só engorda o índice. Mesmo desenho do
-- `crm_tasks_lead_idx` (0210).
create index if not exists crm_tasks_demanda_idx
  on public.crm_tasks (demanda_id) where demanda_id is not null;

comment on column public.crm_tasks.demanda_id is
  'A demanda de atendimento que originou o combinado (#2818). set null, não cascade: encerrar ou apagar a demanda não pode apagar o lembrete que a pessoa escreveu para si mesma — a tarefa continua na lista, com o vínculo zerado. NULL = tarefa avulsa ou presa só a negócio/contato.';
