-- 0084 — o funil do AGENTE aprende a falar o vocabulário do TENANT
--
-- Dois vocabulários que hoje não se conhecem:
--
--   AGENTE    `lead_state.stage` — SETE valores fixos: new, contacted,
--             qualifying, qualified, negotiating, won, lost;
--   PIPELINE  `crm_stages` — arbitrários por tenant. Medidos neste banco:
--             clínica  → Primeiro contato, Avaliação, Proposta enviada,
--                        Negociação, Tratamento fechado, Perdido
--             e-commerce → Carrinho abandonado, Aguardando pagamento, Pago,
--                        Em separação, Enviado, Entregue, Pós-venda, Cancelado
--
-- Sem ponte, o agente que avança o próprio funil não move o card — e o board
-- mostra um negócio parado num estágio que já não é verdade.
--
-- ⚠️ E A PONTE JÁ EXISTE PELA METADE: `crm_stages` tem `is_won` e `is_lost`.
-- Dois dos sete já estão mapeados, por colunas booleanas. Esta migration NÃO
-- cria um mecanismo novo — GENERALIZA um que existe incompleto. A consequência
-- é o CHECK de coerência abaixo: sem ele, `is_won` e `agent_stage_hint`
-- passariam a ser DUAS FONTES capazes de dizer coisas diferentes sobre o mesmo
-- estágio, que é a família de defeito que esta entrega inteira encontrou seis
-- vezes ("um lado mudou e o outro não acompanhou").
--
-- `null` é estado LEGÍTIMO e comum: "Em separação", "Pós-venda" e "Carrinho
-- abandonado" não têm equivalente no funil do agente, e forçar um mapeamento
-- seria inventar semântica que o tenant não declarou.

alter table public.crm_stages
  add column if not exists agent_stage_hint text;

comment on column public.crm_stages.agent_stage_hint is
  'A que passo do funil do AGENTE este estágio corresponde (lead_state.stage). NULL = não corresponde a nenhum, que é legítimo. Coerente com is_won/is_lost por CHECK — ver migration 0084.';

alter table public.crm_stages
  drop constraint if exists crm_stages_agent_stage_hint_check;
alter table public.crm_stages
  add constraint crm_stages_agent_stage_hint_check check (
    agent_stage_hint is null
    or agent_stage_hint = any (array[
      'new', 'contacted', 'qualifying', 'qualified', 'negotiating', 'won', 'lost'
    ]::text[])
  );

-- ⚠️ A COERÊNCIA COM O QUE JÁ EXISTIA. Um estágio marcado `is_won` que se
-- anuncia como 'qualifying' faria o agente e o board discordarem sobre o mesmo
-- lugar — e cada um estaria "certo" pela sua própria fonte. O CHECK torna a
-- divergência IMPOSSÍVEL em vez de improvável.
--
-- Nos dois sentidos, de propósito: `is_won` sem hint é o estado de hoje (válido,
-- e é como todos os clones começam), mas hint='won' num estágio que não é de
-- ganho seria mentira na direção oposta.
alter table public.crm_stages
  drop constraint if exists crm_stages_hint_coerente_com_won_lost;
alter table public.crm_stages
  add constraint crm_stages_hint_coerente_com_won_lost check (
    (agent_stage_hint <> 'won' or is_won)
    and (agent_stage_hint <> 'lost' or is_lost)
    and (not is_won or agent_stage_hint is null or agent_stage_hint = 'won')
    and (not is_lost or agent_stage_hint is null or agent_stage_hint = 'lost')
  );

-- ⚠️ UM ESTÁGIO POR HINT, POR PIPELINE — e este índice é UNIQUE de propósito.
--
-- Eu ia tratar a ambiguidade no resolvedor ("dois estágios com o mesmo hint →
-- recuse mover"). O schema já respondeu melhor: `uniq_crm_stages_pipeline_won` e
-- `uniq_crm_stages_pipeline_lost` JÁ EXISTEM, com o mesmo desenho — parcial, e
-- excluindo arquivados. O produto já decidiu que "dois lugares de ganho no mesmo
-- funil" é impossível, não improvável; não havia razão para os outros cinco
-- passos serem tratados com menos rigor que os dois.
--
-- E a diferença é grande: com o UNIQUE, o tenant DESCOBRE o erro ao configurar
-- — o banco recusa na hora, com o estágio na frente dele. Com tratamento no
-- resolvedor, ele descobriria meses depois, quando um negócio não se movesse e
-- ninguém soubesse dizer por quê.
--
-- `is_archived = false` acompanha o precedente: estágio arquivado é histórico e
-- não disputa o mapeamento com o que está em uso.
create unique index if not exists uniq_crm_stages_pipeline_hint
  on public.crm_stages (pipeline_id, agent_stage_hint)
  where agent_stage_hint is not null and is_archived = false;

-- ---- backfill do que JÁ ESTÁ DECIDIDO, e só dele ----
-- `is_won`/`is_lost` são declaração explícita do tenant sobre aquele estágio;
-- copiá-los para o hint não inventa nada. NENHUM outro estágio é adivinhado:
-- inferir 'qualifying' de um nome como "Avaliação" seria o sistema decidindo
-- semântica por semelhança de palavra, e erraria em português de outro nicho.
update public.crm_stages
   set agent_stage_hint = 'won'
 where is_won and agent_stage_hint is null;

update public.crm_stages
   set agent_stage_hint = 'lost'
 where is_lost and agent_stage_hint is null;
