-- manifest: **O `send_ledger` passa a guardar ONDE cada ENVIO começa (#4370).** `send_ledger.envio_seq smallint` = o `seq` da PRIMEIRA mensagem física do envio (`send_message` do turno) a que a linha pertence; as bolhas do envio levam o mesmo número. A consulta do reprocesso (`SQL_MENSAGEM_GUARDADA`) filtra por ele em vez de `seq >= $3`, que é o contador do TURNO inteiro e por isso concatenava o envio seguinte. Nulo em toda linha gravada antes desta migration e em todo caminho que não é o turno da prospecção (follow-up de mensagem única, apresentação) — a consulta cai no comportamento anterior para essas linhas. Só acrescenta coluna: nenhum envio muda, e `unique (job_id, seq)` fica como está. Idempotente; espelho no apêndice do `supabase/baseline.sql`, antes da VARREDURA anon (0116).
-- ============================================================================
-- 9407 — O LEDGER DO ENVIO PRECISA SABER ONDE O ENVIO TERMINA.
--
-- ## O defeito que esta coluna fecha
--
-- `send_ledger` nasceu com UMA linha por mensagem FÍSICA, identificada por
-- `unique (job_id, seq)` (0003). O `seq` é o contador do TURNO: em
-- `lib/agent-engine/agent/inbound-turn.ts` ele nasce em 0 no início do run e
-- cresce a cada bolha enviada, e continua crescendo entre duas chamadas de
-- `send_message` do MESMO turno (mesmo `job_id`). Quem lê o ledger só pelo
-- `seq` não consegue, portanto, separar "as bolhas do envio 1" de "as bolhas
-- do envio 2".
--
-- O reprocesso de uma mensagem guardada (`SQL_MENSAGEM_GUARDADA`, em
-- `lib/prospecting/saida-configuravel.ts`) fazia exatamente isso: concatenava
-- `seq >= $3`. O conserto do #4370 (a saída personalizada mora na ÚLTIMA
-- bolha) precisava do envio INTEIRO e passou a concatenar o TURNO inteiro. Os
-- dois cenários medidos pelo mantenedor, com a saída no fim do corpo de que
-- ela faz parte:
--
--   * cenário B — 2 envios no turno, saída no 1º: a concatenação puxa o texto
--     do envio SEGUINTE, não termina na frase, e o reenvio sai sem ela
--     enquanto `exit_offered_at` diz que foi oferecida;
--   * cenário C — 2 envios no turno, saída no 2º: o 1º envio "acha" a frase
--     que é do 2º, e o PARAR aparece duas vezes.
--
-- O cenário A (1 envio em 3 bolhas, saída na última) já estava certo e
-- continua certo: o envio começa na 1ª bolha e termina na última, então o
-- intervalo do envio é o mesmo turno.
--
-- ## A fronteira é gravada NA ESCRITA
--
-- Quem sabe onde um envio começa é quem chama o canal: o `send:` do turno
-- conhece o `seq` da PRIMEIRA bolha antes de enviar a primeira (é o
-- `seq + 1` daquele momento, o mesmo que já vira `mensagem.seq` na saída
-- configurável). Ele passa esse número adiante (`envioSeq` em
-- `ChannelSendInput`), e o escritor do ledger grava o mesmo valor em TODA
-- linha do envio. O reprocesso então lê `envio_seq = $3` — as bolhas DESTE
-- envio, na ordem do `seq` — e não o turno.
--
-- Não é coluna de BLOCO lógico, nem muda a identidade da intenção: a chave
-- continua `(job_id, seq)`, uma linha por mensagem física, e o `rotate` de
-- uma tentativa lógica nova preserva o `envio_seq` (o envio é o mesmo; o que
-- muda é a tentativa).
--
-- ## Por que NULL e não um backfill
--
-- Linha antiga não tem como descobrir a fronteira: a informação não existia em
-- lugar nenhum (o `seq` do turno só, e o corpo, que não é guardado — só o
-- hash). Um backfill ADIVINHARIA, e adivinhar aqui significa amarrar a saída ao
-- corpo errado. NULL é honesto — "não sei onde este envio termina" — e a
-- consulta trata NULL como a régua anterior (`seq >= $3`), que é exatamente o
-- comportamento de antes desta migration. Não há regressão para o passado; o
-- passado já era o caso ruim, e ele se resolve sozinho conforme as linhas
-- antigas envelhecem (o `send_ledger` é podado junto do job).
--
-- Os caminhos que NÃO são o turno da prospecção continuam sem gravar a coluna:
-- follow-up (`seq: 1` fixo, UMA mensagem física — o fallback é idêntico ao que
-- era) e envio fixo. Nenhum deles perde nada. A nota de voz do `send_message`
-- grava a coluna como as bolhas: ela é o envio inteiro.
-- ============================================================================

alter table public.send_ledger
  add column if not exists envio_seq smallint;

comment on column public.send_ledger.envio_seq is
  'Migration 9407. O `seq` da PRIMEIRA mensagem física do ENVIO a que esta '
  'linha pertence (#4370). O `seq` sozinho é o contador do TURNO inteiro e '
  'não separa dois envios do mesmo job; o reprocesso da saída configurável '
  'lê as bolhas por `envio_seq = <1ª bolha do envio>`. NULL = linha gravada '
  'antes da 9407 (a consulta cai na régua anterior, `seq >= $3`) ou envio de '
  'mensagem única fora do turno da prospecção.';
