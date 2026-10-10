-- 0416 · AUTORIA "EM NOME DE" NA MENSAGEM (issue #1613)
--
-- O problema: quem envia ao cliente por token — ERP, sistema de cobrança,
-- agenda externa — manda com o TOKEN DA ORGANIZAÇÃO. A mensagem nascia com
-- `sent_via='system'` (ou 'ai') e `sent_by_user_id` nulo, aparecia como
-- "Sistema" no balão e a conversa PERDIA que foi uma pessoa no outro sistema
-- que decidiu a cobrança, o lembrete, o parabéns.
--
-- 1 · COLUNA NOVA, nullable e sem backfill: `messages.sent_on_behalf_of_user_id`
--     guarda a PESSOA em nome de quem o token enviou. Linha antiga continua
--     `null`, que é o mesmo "não sei quem mandou" de sempre — inventar valor
--     para o histórico seria forjar autoria retroativamente.
--
-- 2 · SEM FK para `auth.users`, do mesmo jeito que `sent_by_user_id` (que também
--     não tem): as duas colunas apontam para quem está vivo no sistema de
--     identidade da instalação, e uma FK aqui morreria no delete do usuário
--     sem apagar a mensagem — a linha existe para contar o que aconteceu.
--     O filtro de MEMBRO ativo é da aplicação (`app/api/v1/messages/route.ts`),
--     porque a pergunta é "membro desta organização, papel agent+, não
--     revogado" — e a org vem da linha do token, nunca do corpo.
--
-- 3 · SEM policy nova: a RLS de `messages` é por organização e cobre a linha
--     inteira; o campo é gravado pelo handler só depois do gate
--     `messages:on_behalf` no escopo do token, e recusado em 403 quando o token
--     não o tem.
--
-- 4 · Idempotente (`add column if not exists`): o `update.sh` do clone
--     re-executa o apêndice inteiro do `baseline.sql` a cada atualização.

alter table public.messages
  add column if not exists sent_on_behalf_of_user_id uuid;

comment on column public.messages.sent_on_behalf_of_user_id is
  'Autoria "em nome de" (#1613, migration 0416): a PESSOA — membro ativo agent+ da organização — em nome de quem um token enviou esta mensagem. null em todo envio direto. Só a rota POST /api/v1/messages grava, e só com o escopo messages:on_behalf; o balão mostra "Fulano · via {token}" a partir de metadata.sent_on_behalf.';
