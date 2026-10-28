-- Avaliações do Google (Perfil da Empresa) entram na Central como conversa.
--
-- ─── Por que este arquivo existe ───────────────────────────────────────────
--
-- A fatia 1 da #3510 traz as avaliações do Google para a Inbox reusando
-- `conversations`/`messages` — é o que faz a avaliação aparecer na lista, no
-- detalhe, na busca e nas contagens sem uma segunda tela com as mesmas quatro
-- coisas. Só que `conversations_channel_check` aceita hoje
-- ('whatsapp', 'instagram', 'facebook'): sem somar 'googlebusiness', o primeiro
-- INSERT de avaliação bate 23514 e a sincronização morre verde do lado de fora
-- (o erro é do banco, não da leitura).
--
-- ─── Sem tabela nova, e por isso sem grants ───────────────────────────────
--
-- Nenhuma tabela, coluna ou função nasce aqui: a avaliação usa
-- `conversations.metadata` (nota, escopo, respondida) e `messages.metadata`.
-- Logo não há `grant`/`revoke` a acrescentar, e o bloco da VARREDURA anon não é
-- tocado — a doutrina do baseline vale para objeto NOVO.
--
-- ─── Uma constraint, um bloco ─────────────────────────────────────────────
--
-- O vocabulário vive num bloco ÚNICO no `baseline.sql` (o apêndice da 0368),
-- atualizado no mesmo commit desta migration: dois drop+add da MESMA constraint
-- abrem duas janelas sem CHECK durante o `update.sh` e o último a rodar decide
-- o vocabulário — é a razão da cerca
-- `tests/unit/baseline-constraint-reconstruida.test.ts`.
--
-- Idempotente: `drop … if exists` + `add`.

alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check
  check (channel in ('whatsapp', 'instagram', 'facebook', 'googlebusiness'));
