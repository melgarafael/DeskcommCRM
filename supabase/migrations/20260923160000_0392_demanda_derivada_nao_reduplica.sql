-- 0392 — o `update.sh` do clone parou de duplicar a demanda que já existia.
--
-- ## O defeito, medido
--
-- A 0136 trouxe o backfill histórico das demandas (R1 a partir de `agent_cases`,
-- R2 a partir das conversas que nunca escalaram), e ele vive no apêndice do
-- `baseline.sql`, que o kit self-host re-aplica INTEIRO a cada `update.sh`.
--
-- O guard de R2 era idempotente só **contra si mesmo**: procurava outra linha
-- `origem = 'derivada'` com o mesmo `aberta_em`. A 0138 passou a abrir a demanda
-- `origem = 'inbound'` no ponto de entrada (trigger em `messages`), e essa linha
-- é invisível para o guard. Medido em pg17 com os dois blocos do baseline da
-- main de 23/09 (install + 1 conversa com mensagem de entrada + update):
--
--     depois do install + mensagem : inbound=1
--     depois do update.sh          : inbound=1  derivada=1
--
-- Sintoma mudo: o Radar publica o dobro de "demandas abertas sem próximo passo"
-- e `fn_atrito_metrics` devolve `escopo.demandas` dobrado.
--
-- ## O que esta migration faz, e o que ela NÃO faz
--
-- Aqui só a AUTO-CURA dos dados: apaga a duplicata já criada. O guard novo
-- (`not exists` em `demanda_conversas` para a conversa) vive no apêndice do
-- `baseline.sql`, que é onde R2 re-executa — migration roda uma vez. O mesmo
-- `delete` está lá também, para o clone do kit, que só aplica o baseline.
--
-- Conservadora de propósito. Só sai a 'derivada' INTOCADA (sem próximo passo,
-- sem lead, sem dono humano, sem caso), ligada a UMA conversa só, e nascida
-- DEPOIS de outra demanda de origem real naquela conversa. A última condição
-- separa a duplicata da derivada legítima: a do backfill original é anterior
-- ao trigger, e a 'inbound' que aparece numa conversa reaberta é mais nova do
-- que ela — essa derivada é histórico e fica. Em banco que nunca duplicou, é
-- no-op; re-aplicar é no-op.
--
-- E NÃO sai a duplicata que já virou referência. O passo 2 do backfill da 0222
-- escolhe a vigente pelo maior `aberta_em`; a derivada tem `cv.created_at`, a
-- 'inbound' tem `m.sent_at` — timestamp do WAHA em SEGUNDOS, anterior ao insert
-- da conversa. Então a duplicata costuma vencer: vira `current_demanda_id`, e o
-- passo 4 carimba `messages.demanda_id` com ela. Apagá-la ali zera essas
-- referências (`on delete set null`), a próxima entrada abre uma TERCEIRA
-- demanda, e o acompanhamento com fronteira nela é cancelado como vencido
-- (`fn_meet_boundary_current`) — o que a 0222 existe para evitar. Uma duplicata
-- vigente segue contando dobrado no Radar; é o preço menor, e ela deixa de ser
-- escolhida quando a conversa fecha e alguém a encerra.

delete from public.demandas d
 where d.origem = 'derivada'
   and d.agent_case_id is null
   and d.lead_id is null
   and d.dono_user_id is null
   and d.proximo_passo is null
   and (select count(*) from public.demanda_conversas v where v.demanda_id = d.id) = 1
   and not exists (select 1 from public.conversations c where c.current_demanda_id = d.id)
   and not exists (select 1 from public.messages m where m.demanda_id = d.id)
   and not exists (select 1 from public.lead_checkpoints k where k.demanda_id = d.id)
   and exists (
     select 1
       from public.demanda_conversas dc
       join public.demanda_conversas outra
         on outra.conversation_id = dc.conversation_id and outra.demanda_id <> d.id
       join public.demandas d2 on d2.id = outra.demanda_id
      where dc.demanda_id = d.id
        and d2.origem <> 'derivada'
        and d2.created_at < d.created_at
   );
