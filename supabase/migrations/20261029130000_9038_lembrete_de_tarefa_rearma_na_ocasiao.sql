-- manifest: **O lembrete de tarefa rearma na OCASIÃO, não na tarefa (#3639).** `agent_inbox_items.task_reminder_due_at timestamptz null` guarda o PRAZO que originou o aviso `task_due`/`task_overdue`; junto de `para_user_id` (0689) ele fecha a identidade do lembrete — categoria + tarefa + responsável + prazo —, então trocar o responsável ou adiar o prazo é ocasião NOVA e volta a avisar, enquanto a rodada repetida sem mudança continua silenciosa (#2529). Nulo nos avisos que não são de prazo de tarefa; o de compromisso tem coluna própria (`appointment_revision`, 0224). Backfill dos avisos existentes usa o prazo ATUAL da tarefa (quem teve o prazo alterado antes desta migration é avisado uma vez, que é exatamente o defeito que ela conserta) e `inbox_task_reminder_ocasiao_unique` fecha a corrida de duas rodadas sobre a MESMA ocasião, com dedupe antes de criar o índice. Idempotente.

-- ============================================================================
-- 9038 — O LEMBRETE DE TAREFA REARMA NA OCASIÃO (#3639)
--
-- A trava de "já avisado" da #2529 é o próprio item da Central: o par
-- `kind + ref_id` dizia "esta tarefa já pediu gente". Só que uma tarefa pede
-- gente MAIS DE UMA VEZ, e por motivos diferentes: outro responsável assumiu,
-- ou o prazo foi adiado. Com a identidade no par, os dois casos ficavam mudos —
-- o aviso antigo "cobria" a situação nova, quem assumia nunca era avisado e
-- adiar para amanhã não rearmava a antecedência de amanhã.
--
-- A coluna guarda o dado que faltava: QUAL prazo motivou o aviso. Com o
-- `para_user_id` da 0689 (o responsável que recebeu), a ocasião fica completa —
-- categoria + tarefa + responsável + prazo — e nenhuma outra coluna é
-- necessária: o responsável já estava gravado, e o prazo é uma data.
--
-- Por que NÃO uma revisão incrementada na tarefa (`appointment_revision`, 0224,
-- é o molde do compromisso): revisão exige que TODO caminho de escrita lembre
-- de incrementar — PATCH da tarefa, atribuição em lote, automação, SQL de
-- operação. Um deles esquece e o lembrete volta a ficar mudo, sem erro
-- nenhum. O prazo e o responsável são LIDOS da própria linha da tarefa a cada
-- rodada: qualquer caminho que os mude produz ocasião nova, de graça.
--
-- Nulo é o aviso que não é de prazo de tarefa (todos os outros kinds) e o
-- aviso de compromisso, que registra a revisão dele na coluna própria. O
-- backfill abaixo só alcança `ref_kind = 'task'` e usa o prazo ATUAL da
-- tarefa — o melhor registro disponível, e o que faz quem já teve o prazo
-- adiado receber o aviso uma vez só, em vez de nunca.
-- ============================================================================

alter table public.agent_inbox_items
  add column if not exists task_reminder_due_at timestamptz null;

comment on column public.agent_inbox_items.task_reminder_due_at is
  'Prazo que originou o aviso de lembrete de tarefa. Com categoria, ref_id e para_user_id forma a OCASIÃO do aviso: prazo novo ou responsável novo rearma; mesma ocasião não repete (#3639, #2529).';

-- Backfill: o aviso legado não guardou o prazo que o motivou. O prazo atual da
-- tarefa é a melhor aproximação, e é a conservadora — tarefa cujo prazo NÃO
-- mudou continua sem aviso novo; a que mudou ganha o aviso que faltava.
update public.agent_inbox_items as aviso
   set task_reminder_due_at = tarefa.due_date
  from public.crm_tasks as tarefa
 where aviso.ref_kind = 'task'
   and aviso.kind in ('task_due', 'task_overdue')
   and aviso.ref_id = tarefa.id
   and aviso.task_reminder_due_at is null
   and tarefa.due_date is not null;

-- Duas rodadas concorrentes podiam gravar o MESMO aviso (a leitura de "já
-- avisado" não é transacional). O índice único abaixo exige uma linha por
-- ocasião, então o que já duplicou é fechado ANTES: fica a mais antiga, e as
-- repetidas viram `resolved` — mesma ocasião, mesmo aviso, sem perder histórico.
-- O índice deixa o `resolved` de fora, e é isso que faz o dedupe valer: sem o
-- filtro, a repetida resolvida continuava dentro dele e a criação do índice
-- falhava (medido num pg17 com dois avisos legados da mesma tarefa). A trava
-- da rodada lê todos os status, então o aviso resolvido segue sem repetir.
with repetidas as (
  select id,
         row_number() over (
           partition by organization_id, ref_id, kind, para_user_id, task_reminder_due_at
           order by created_at, id
         ) as posicao
    from public.agent_inbox_items
   where ref_kind = 'task'
     and task_reminder_due_at is not null
)
update public.agent_inbox_items as aviso
   set status = 'resolved',
       resolved_at = coalesce(aviso.resolved_at, now())
  from repetidas
 where aviso.id = repetidas.id
   and repetidas.posicao > 1
   and aviso.status <> 'resolved';

create unique index if not exists inbox_task_reminder_ocasiao_unique
  on public.agent_inbox_items (organization_id, ref_id, kind, para_user_id, task_reminder_due_at)
  where ref_kind = 'task' and task_reminder_due_at is not null and status <> 'resolved';

notify pgrst, 'reload schema';
