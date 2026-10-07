-- manifest: **`anon` e `authenticated` deixam de ter `TRUNCATE` em `ai_budgets` (fechamento da #2258).** A 0160 revogou INSERT/UPDATE/DELETE da chave pública, mas o `TRUNCATE` que o snapshot concedia ficou — e ele não passa pela RLS. Nenhum consumidor de `ai_budgets` o usa: toda escrita é service role (medido no cabeçalho da 0160). No `baseline.sql` o revoke acompanha os grants do snapshot desde a #2255; esta migration aplica o mesmo revoke em quem atualiza pela CADEIA. O ACL final muda de propósito, só nesta tabela e só neste privilégio.

-- 0537: a chave pública (anon/authenticated) perde TRUNCATE em ai_budgets
--
-- TRUNCATE não é filtrado pela RLS, e o papel `anon` é a chave que vai ao
-- browser. A 0160 já tinha medido que TODO escritor de `ai_budgets` usa
-- service role; o `T` ficou de fora do revoke daquele bloco e sobrevivia no
-- estado final. Revogar aqui não muda contrato nenhum de leitura: SELECT,
-- INSERT e UPDATE dos membros seguem como estavam (o SELECT é escopado pela
-- policy da 0150, e o INSERT/UPDATE/DELETE já eram negados pela 0160).
--
-- Idempotente: revoke de privilégio que já não existe é no-op, e o
-- `update.sh`/`baseline.sql` reaplica o mesmo comando ao lado dos grants.
revoke truncate on table public.ai_budgets from authenticated, anon;
