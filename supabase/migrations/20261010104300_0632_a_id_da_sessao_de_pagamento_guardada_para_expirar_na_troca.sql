-- manifest: **A sessão de pagamento fica guardada para expirar na troca de plano (#2609).** Hoje a troca é recusada enquanto há link de pagamento em aberto (o `checkout_em_aberto` da 0583/#2368), e a empresa espera o link expirar ou ser pago; aqui a recusa vira ação: `cobranca_assinaturas.checkout_sessao_id` guarda a id da sessão criada NO PROVEDOR para o link (Stripe `cs_…` na resposta do `POST /checkout/sessions`, Asaas `pay_…` da cobrança cujo `invoiceUrl` virou o link), escrita pela rota do Assinar junto com `checkout_url`/`checkout_expira_em` e zerada com eles (reserva da fase 1, `limparCheckout` da releitura e a própria troca). Com a id na mão, `troca.ts` expira a sessão NO PROVEDOR antes da escrita — fora de transação, como todo chamado ao provedor —, limpa o link local e a troca vale na hora; se o provedor não confirmar, nada muda e vale a recusa de sempre (sem a id, linha anterior à 0632, a recusa continua intacta). Coluna opcional `text`, idempotente (`add column if not exists`), sem backfill: nula é exatamente o comportamento de hoje. Mesmo bloco entra como apêndice no `supabase/baseline.sql` (é o que o kit self-host aplica), ANTES do bloco da VARREDURA anon; nenhuma linha nova no MANIFEST.md — a descrição mora aqui.
-- 0632: a id da sessão de pagamento no provedor, guardada para a troca de plano expirá-la (#2609)
--
-- ─── O defeito ───────────────────────────────────────────────────────────────
--
-- A empresa muda de plano no teste grátis enquanto o link de pagamento está em
-- aberto: a troca é RECUSADA (409 `checkout_em_aberto`) até o link expirar ou ser
-- pago. A guarda é correta — deixar o link vivo com o preço do plano antigo é uma
-- cobrança errada —, mas obriga a empresa a esperar até 24 h por uma decisão que
-- o provedor executa em uma chamada.
--
-- O que faltava era a PONTA: a rota do Assinar grava o link (`checkout_url`) e o
-- prazo (`checkout_expira_em`), mas não guarda QUAL sessão o provedor criou —
-- logo, não há o que expirar lá. Sem essa id só há dois caminhos, e os dois são
-- ruins: recusar (o defeito) ou limpar o link só no nosso banco (o link antigo
-- continua valendo no provedor, e cobra o plano velho).
--
-- ─── A peça ──────────────────────────────────────────────────────────────────
--
-- Uma coluna opcional em `cobranca_assinaturas`, no mesmo trio do link:
--
--   checkout_url        o link que a empresa clica
--   checkout_expira_em  até quando ele vale (e a reserva da fase 1)
--   checkout_sessao_id  A ID DA SESSÃO NO PROVEDOR — quem expira o link lá fora
--
-- Escrita pela rota do Assinar na fase 3, junto com o link (`inicio.sessaoId`,
-- devolvida por `iniciarAssinatura` dos DOIS adaptadores); zerada na reserva da
-- fase 1 (uma sessão nova substitui a velha) e em toda limpeza do link
-- (`limparCheckout` da releitura e a própria troca). Os três ou estão juntos, ou
-- são nulos — a coluna não vive link sem sessão.
--
-- Sem backfill de propósito: linha antiga com link em aberto e sessão nula é o
-- comportamento de HOJE, e a recusa `checkout_em_aberto` continua valendo para
-- ela. Inventar id (lendo a URL, por exemplo) daria a garantia sem a garantia.
--
-- Idempotente (`add column if not exists` + comentário, que tolera re-aplicação)
-- e com `notify pgrst`, para o PostgREST recarregar o schema. O MESMO bloco entra
-- no `supabase/baseline.sql`, ANTES do bloco da VARREDURA anon (0116) — é o que
-- o kit self-host aplica, install E update.

alter table public.cobranca_assinaturas
  add column if not exists checkout_sessao_id text;

comment on column public.cobranca_assinaturas.checkout_sessao_id is
  'A id da sessão de pagamento criada no PROVEDOR para o link em aberto (Stripe cs_…, Asaas pay_…) — issue #2609. Nasce com checkout_url/checkout_expira_em na fase 3 do Assinar e é zerada com eles: é ela que a troca de plano expira no provedor antes de mudar o plano, para a troca valer na hora sem deixar um link vivo com o preço antigo. Nula = nada em aberto, ou linha anterior à 0632 (aí a troca com link em aberto segue recusada como sempre).';

notify pgrst, 'reload schema';
