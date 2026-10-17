-- manifest: **O aviso da Central pode ter DONO (#2529, doc de decisão 162, caminho A).** `agent_inbox_items.para_user_id uuid null references auth.users(id) on delete cascade`: nulo é o aviso da EMPRESA (todos os avisos de hoje, sem backfill); preenchido, só aquela pessoa o vê. O cron `task-reminder` grava o responsável da tarefa ali, e a leitura da Central (lista e contador do sino), o "Marcar todos resolvidos" e o resolver de um aviso passam a enxergar `para_user_id is null or para_user_id = <quem pediu>` — o colega não vê o aviso de prazo do outro, e o "Marcar todos" de um não resolve o do outro. Sem índice: a leitura já filtra por organização e status, e a coluna só recorta o que sobra. Idempotente (`add column if not exists`); o mesmo bloco entra no fim do `baseline.sql`, antes da VARREDURA anon.

-- ============================================================================
-- 0689 — O AVISO DA CENTRAL COM DESTINATÁRIO (#2529, doc 162)
--
-- Até aqui todo aviso da Central era da ORGANIZAÇÃO: a tabela não tinha campo
-- de pessoa. O lembrete de prazo da tarefa (0655) nasce ligado para toda tarefa
-- com prazo, e numa equipe de 10 pessoas virava o aviso de cada tarefa de cada
-- colega no sino de todos — e o "Marcar todos resolvidos" de qualquer um
-- resolvia o de todo mundo.
--
-- A coluna é opcional de propósito: nulo é exatamente o comportamento de hoje
-- (aviso da empresa). `on delete cascade` porque um aviso pessoal de quem saiu
-- da instalação não tem mais leitor — ficaria aberto para ninguém.
-- ============================================================================

alter table public.agent_inbox_items
  add column if not exists para_user_id uuid null references auth.users(id) on delete cascade;

comment on column public.agent_inbox_items.para_user_id is
  'Destinatário do aviso. Nulo = aviso da organização inteira; preenchido = só esta pessoa vê, resolve e conta no sino (doc 162, #2529).';

notify pgrst, 'reload schema';
