-- manifest: índice parcial da outbound `queued`, para o portão de minuto do piso ocioso e a varredura da espera esquecida (#3907) não lerem `messages` inteira.
-- 9242 — índice da mensagem que espera em `queued`.
--
-- `recover-stuck-messages` passou a ler outbound `queued` por idade, e o piso
-- ocioso (`mensagem_presa`) faz a mesma pergunta num `exists` a cada retrato.
-- O único índice de `messages` que filtra status,
-- `idx_messages_org_status_created`, é parcial para `sending` e `failed`:
-- `queued` não tem caminho indexado. A chave é só `created_at` porque as duas
-- leituras cruzam organizações. Parcial porque `queued` é uma fração mínima da
-- tabela. `status` já está no predicado de outro índice, então a troca de status
-- não perde HOT update por causa deste.
--
-- Sem CONCURRENTLY: o runner envolve a migration em transação. A criação trava
-- escrita em `messages` pelo tempo de construir o índice.
-- Sem função nova (nada a revogar de anon).

create index if not exists idx_messages_outbound_queued_created
  on public.messages (created_at)
  where direction = 'outbound' and status = 'queued';
