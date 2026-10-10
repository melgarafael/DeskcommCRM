-- 0273 — a resposta revisada para de segurar a Zona de perigo.
--
-- DEFEITO (issue #949). A Zona de perigo (Configurações › Organização › apagar
-- dados operacionais) apaga, na ordem de `RAIZES_DO_APAGAMENTO`, começando por
-- `messages` com o filtro da organização
-- (`lib/settings/apagar-dados-operacionais.ts`). Numa organização que já enviou
-- uma resposta revisada, esse PRIMEIRO delete é recusado pelo banco:
--
--   update or delete on table "messages" violates foreign key constraint
--   "ai_reply_drafts_message_id_fkey" on table "ai_reply_drafts"
--   (SQLSTATE 23503)
--
-- O app traduz isso em `{ ok: false, falha: { tabela: "messages", ... } }` e o
-- reset morre na primeira raiz, sem apagar nada. Pior: a ordem existe
-- justamente para que a parada deixe o banco íntegro — aqui ela deixa a
-- organização suja e a ação parece "quebrada e sem explicação" para o operador.
--
-- CAUSA. `ai_reply_drafts.message_id` foi criada (migration 0227) como
--   message_id uuid references public.messages(id)
-- SEM ação de exclusão, ou seja NO ACTION: o Postgres recusa o delete do pai
-- enquanto existir rascunho apontando para ele, mesmo que o rascunho vá morrer
-- no passo seguinte (o cascade de `conversations` alcança `ai_reply_drafts`
-- porque `ai_reply_drafts.conversation_id` é ON DELETE CASCADE).
--
-- EVIDÊNCIA PARA A AÇÃO ESCOLHIDA — `on delete set null`.
-- 1. É o que as TRÊS FKs irmãs que apontam para `public.messages(id)` já fazem
--    no baseline aplicado: `ai_agent_suggestions.message_id` (v. 11337),
--    `messages.reply_to_message_id` (v. 14759) e
--    `calendar_appointments.outcome_message_id` (v. 19939). Esta era a única
--    fora do padrão — o defeito é divergência, não falta de regra.
-- 2. A irmã que passou pelo mesmo tipo de decisão já escreveu o porquê, no
--    cabeçalho de `messages.reply_to_message_id`: "apagar a citada não pode
--    levar junto a resposta, que é conteúdo próprio. Perder o fio é aceitável;
--    perder a resposta é apagar histórico por causa de um ponteiro." O rascunho
--    revisado é conteúdo próprio: `approved_body`, `edited_by`, o trace que
--    sustentou a decisão e o `feedback` humano são registro de operação.
-- 3. `message_id` é NULLABLE (o rascunho existe desde antes do envio; o filtro
--    de leitura do app sempre usou `message_id is null` como "ainda não enviado"),
--    então SET NULL é legal e não precisa de DEFAULT nem de backfill.
--
-- POR QUE NÃO `on delete cascade`. Existe caminho legítimo que apaga MENSAGEM
-- por motivo que não tem nada a ver com a resposta: a deduplicação de eco
-- (`delete from public.messages ... sent_via = 'external_device' ...`,
-- baseline v. ~21770) e a exclusão de uma mensagem avulsa pela própria UI
-- (`app/api/v1/messages/_handler.ts`). Com CASCADE, limpar um eco apagaria um
-- rascunho revisado — o histórico sumindo por causa de um ponteiro, exatamente
-- o que a doutrina da irmã de 14759 proíbe. E CASCADE não acrescenta nada à
-- promessa da Zona de perigo: quem leva os rascunhos da organização é o cascade
-- de `conversations`, que continua valendo. O que a Zona de perigo precisa não
-- é que o rascunho morra JUNTO com a mensagem; é que a mensagem possa ir embora.
--
-- EFEITO NO CAMINHO DO DEFEITO. `delete from messages` deixa de ser recusado
-- (o `message_id` dos rascunhos da organização vira NULL) e a lista segue:
-- `conversations` cai, o cascade leva os `ai_reply_drafts` por
-- `conversation_id`. O resultado final é o prometido — nada de atendimento
-- sobra —, mas sem o 23503 no meio do caminho.
--
-- MESMO DEFEITO EM ROTAS IRMÃS (levantado por grep, ver corpo do PR).
-- Caminhos de escrita que apagam `messages` e herdavam a mesma recusa:
-- `app/api/v1/messages/_handler.ts` (excluir uma mensagem avulsa) e
-- `app/api/v1/contacts/_handler.ts` (excluir o contato apaga as mensagens dele
-- antes de `conversations`), e ainda `fn_reply_record_receipt` (a deduplicação
-- do eco do aparelho do operador, baseline v. 21770). Todos passam a funcionar
-- com esta migration, sem tocar em TypeScript.
-- NÃO afetados (levantamento literal): as rotas de admin
-- (`app/api/v1/admin/tenants/[id]/route.ts`, `admin/inbox/conversations/[id]/route.ts`)
-- só contam/leem `messages`; as funções de LGPD/retenção não têm nenhuma linha
-- de `delete from public.messages`; e os demais `.from("messages")` de `lib/`
-- são leitura/update.
--
-- Nome do constraint preservado (`ai_reply_drafts_message_id_fkey`): é o nome
-- que o Postgres deu à FK inline da 0227 e o que aparece na mensagem de erro
-- que os operadores citam no suporte.
--
-- Idempotente: `drop constraint if exists` + `add constraint`. Aplicar duas
-- vezes deixa o banco no mesmo estado.

alter table public.ai_reply_drafts
  drop constraint if exists ai_reply_drafts_message_id_fkey;

alter table public.ai_reply_drafts
  add constraint ai_reply_drafts_message_id_fkey
  foreign key (message_id) references public.messages(id) on delete set null;

notify pgrst, 'reload schema';
