-- 0073 — a proposta do agente ganha IDENTIDADE, e o caso ambíguo ganha lugar
--
-- Duas mudanças que a Wave 4 pediu depois da primeira entrega, e cada uma
-- fecha um buraco diferente:
--
-- 1) `next_action_seq`: a trava de autorização comparava o TEXTO da proposta, e
--    texto igual não significa proposta igual. O agente escreve "enviar
--    proposta"; o cliente muda o pedido; o agente escreve "enviar proposta" DE
--    NOVO, palavra por palavra, significando outra coisa — e a trava passaria.
--    Pior: se o humano já tivesse ignorado a primeira, a segunda ficaria
--    indistinguível dela.
--
--    NÃO se usa `updated_at` para isso: ele se move por BANT, por estágio e por
--    qualquer escrita do estado — move DEMAIS. O texto move de MENOS. A regra é
--    comparar a coisa que muda exatamente quando o que importa muda, e por isso
--    entra um contador que só o caminho de escrita da próxima ação incrementa.
--
-- 2) `next_action_ambiguous` no CHECK de `agent_inbox_items`: quando o contato
--    tem N negócios abertos, a proposta não aparece em card nenhum — e NÃO
--    ADIVINHAR NÃO PODE VIRAR NÃO AVISAR. Sem isto a IA propõe, ninguém vê, e a
--    demanda apodrece em silêncio, que é a morte que este épico existe para
--    matar. O item vai para a caixa, que já existe: nada de slot novo no card.
--
--    Kind PRÓPRIO em vez de `other`: vago não se filtra nem se conta, e este
--    item precisa ser encontrável.

-- ---- 1. identidade da proposta ----
alter table public.lead_state
  add column if not exists next_action_seq bigint not null default 0;

comment on column public.lead_state.next_action_seq is
  'Identidade da proposta corrente. Incrementa a CADA escrita de next_action, inclusive quando o texto novo é idêntico ao anterior — é o que distingue "a mesma proposta" de "a mesma frase". A autorização humana carrega este número; a execução o compara. Nunca usar updated_at no lugar: ele se move por outras escritas do estado.';

-- ---- 2. o ambíguo tem para onde ir ----
-- `followup_dead` está aqui porque a lista é a do BASELINE, não a do banco de
-- dev: os dois divergiram, e o dev está com uma versão ANTERIOR da constraint
-- (sem esse valor) enquanto lib/followup/engine.ts insere exatamente esse kind.
-- Reconstruir a partir do banco apagaria o valor e mataria, em silêncio, o
-- aviso de enrollment morto. A fonte de verdade é o arquivo versionado.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (
    kind = any (
      array[
        'qr_rescan',
        'job_dead',
        'event_dead',
        'budget_exceeded',
        'handoff',
        'promotion_review',
        'judge_unaligned',
        'followup_dead',
        'snooze_expired',
        'next_action_ambiguous',
        'other'
      ]::text[]
    )
  );
