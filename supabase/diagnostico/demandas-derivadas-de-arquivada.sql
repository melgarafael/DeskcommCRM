-- =============================================================================
-- DIAGNÓSTICO SOMENTE-LEITURA — #2992
-- Demandas ABERTAS derivadas de conversa ARQUIVADA em instalações que
-- aplicaram o backfill ANTES do #2825.
--
-- O que esta consulta faz: lê. Não escreve, não encerra, não apaga, não
-- inventa desfecho. Uma linha por demanda candidata, com a categoria que a
-- separa de duas coisas que NÃO são resíduo — a demanda legítima e a ambígua.
--
-- ── Por que a medição vem antes do código ──────────────────────────────────
--
-- O #2825 consertou a ORIGEM (`where cv.status <> 'archived'` no R2 do
-- apêndice "Índice de Atrito + DEMANDAS" do baseline.sql): instalação nova não
-- cria mais a derivada de conversa arquivada. Quem já tinha aplicado o backfill
-- pela migration 0136 ou por um `update.sh` anterior continua com as linhas, e
-- elas reaparecem em toda consulta de pendências. Esta consulta conta quantas
-- são, por instalação e por categoria. O destino delas — encerrar, apagar,
-- deixar — é decisão de produto: a constraint `demandas_desfecho_coerente`
-- exige desfecho junto de `fechada_em`, e escolher `resolvida`/`nao_procede`
-- para elas afirmaria um desfecho que não houve.
--
-- ── O universo (quem entra na conta) ──────────────────────────────────────
--
--   origem = 'derivada'            — é a origem que o R2 criou. 'inbound'
--                                    (trigger da 0138), 'handoff', 'followup' e
--                                    'manual' ficam fora: são decisão de gente
--                                    ou de caminho nativo.
--   fechada_em is null            — a issue fala da demanda ABERTA. (Pela
--                                    constraint, desfecho também é null.)
--   nenhuma conversa viva         — ou seja: todas as conversas vinculadas
--                                    estão `archived`, ou não há vínculo
--                                    nenhum. Demanda com canal vivo fica FORA
--                                    por construção: ela atende uma conversa em
--                                    andamento e não é resíduo de nada.
--
-- ── As três categorias (nesta ordem, a primeira que casar vence) ───────────
--
--   legitima        Não é resíduo. Alguma coisa aconteceu depois do backfill:
--                   próximo passo escrito por gente, dono humano, negócio
--                   ligado, caso de escalada, estado avançado, ou nenhum
--                   vínculo (a consulta não apaga o que ela não consegue
--                   explicar). "Próximo passo" só conta quando DIFERE do texto
--                   que o próprio comando de arquivar escreve — senão o
--                   arquivamento se auto-promoveria a sinal de trabalho.
--   ambigua         Resíduo na origem, mas com algo apontando para ela: dois
--                   canais, card (`conversations.current_demanda_id`), ou
--                   referência em `messages`/`lead_checkpoints`/`crm_tasks`
--                   (todas `on delete set null` — apagar zeraria o ponteiro de
--                   quem está usando). Precisa de decisão, não de régua.
--   derivada_limpa  Uma conversa, arquivada, e nada mais: a assinatura exata do
--                   backfill. É a única categoria que um saneamento olharia —
--                   e este arquivo não o faz.
--
-- ── Como rodar ────────────────────────────────────────────────────────────
--
--   psql "$DATABASE_URL" -f supabase/diagnostico/demandas-derivadas-de-arquivada.sql
--
-- O script da casa (scripts/demandas-derivadas-de-arquivada.ts) roda isto numa
-- transação `read only` e imprime a contagem por categoria. Use papel que
-- enxergue todas as organizações (postgres ou service_role): com RLS e um papel
-- de usuário, o resultado sai filtrado pela organização de quem chamou, e um
-- "zero" desses não é uma medição.
--
-- Para o número que dá contexto ao "zero" (quantas derivadas abertas existem ao
-- todo, incluindo as que têm canal vivo), rode à parte:
--
--   select count(*) from public.demandas
--    where origem = 'derivada' and fechada_em is null;
-- =============================================================================

with candidatas as (

  select d.id,
         d.organization_id,
         d.estado,
         d.aberta_em,
         d.agent_case_id,
         d.lead_id,
         d.dono_user_id,
         d.proximo_passo
    from public.demandas d
   where d.origem = 'derivada'
     and d.fechada_em is null
     -- Nenhuma conversa vinculada viva. Casa também com "nenhum vínculo":
     -- `not exists` é verdadeiro quando a subconsulta não acha linha alguma.
     and not exists (
       select 1
         from public.demanda_conversas dc
         join public.conversations cv on cv.id = dc.conversation_id
        where dc.demanda_id = d.id
          and cv.status <> 'archived'
     )
),

fatos as (

  select c.*,
         -- Vínculos: quantos e por quantos canais. A demanda atravessa canais
         -- (cap. 5 §5.4), então dois vínculos podem ser dois canais ou o mesmo
         -- canal duas vezes — as duas colunas ficam no relatório.
         (select count(*)::int
            from public.demanda_conversas dc
           where dc.demanda_id = c.id) as conversas,
         (select count(distinct cv.channel_session_id)::int
            from public.demanda_conversas dc
            join public.conversations cv on cv.id = dc.conversation_id
           where dc.demanda_id = c.id) as canais,
         -- O card da conversa aponta para esta demanda?
         exists (select 1
                   from public.conversations cv
                  where cv.current_demanda_id = c.id) as no_card,
         -- Referências que `on delete set null` zeraria.
         (select count(*)::int from public.messages m         where m.demanda_id = c.id) as mensagens,
         (select count(*)::int from public.lead_checkpoints k where k.demanda_id = c.id) as checkpoints,
         (select count(*)::int from public.crm_tasks t        where t.demanda_id = c.id) as tarefas
    from candidatas c
),

classificadas as (

  select f.*,
         case
           -- 1) Trabalho posterior, na ordem do mais forte para o mais fraco.
           --    O texto entre aspas é o que `fn_service_status` grava sozinho
           --    ao arquivar (baseline.sql, bloco da 0222): tratá-lo como sinal
           --    de gente faria todo resíduo arquivado parecer trabalhado.
           when f.proximo_passo is not null
                and btrim(f.proximo_passo) <> 'Revisar atendimento e registrar o desfecho da demanda'
             then 'legitima'
           when f.dono_user_id is not null then 'legitima'
           when f.lead_id is not null then 'legitima'
           when f.agent_case_id is not null then 'legitima'
           when f.estado <> 'aberta' then 'legitima'
           -- 2) Sem vínculo nenhum: fora do resíduo, porque o resíduo tem
           --    assinatura. A consulta não classifica o que não explica.
           when f.conversas = 0 then 'legitima'
           -- 3) Algo aponta para ela. Precisa de decisão, não de régua.
           when f.conversas > 1 or f.canais > 1 then 'ambigua'
           when f.no_card then 'ambigua'
           when f.mensagens > 0 or f.checkpoints > 0 or f.tarefas > 0 then 'ambigua'
           -- 4) O resto: uma conversa arquivada e nada mais.
           else 'derivada_limpa'
         end as categoria
    from fatos f
),

com_motivo as (

  -- A ordem dos `when` aqui ESPELHA a de `classificadas`: o motivo é o porquê
  -- da categoria, e categoria e motivo que divergem fazem o relatório mentir
  -- sem que nenhuma contagem mude.
  select c.*,
         case c.categoria
           when 'legitima' then
             case
               when c.proximo_passo is not null
                    and btrim(c.proximo_passo) <> 'Revisar atendimento e registrar o desfecho da demanda'
                 then 'proximo_passo_de_gente'
               when c.dono_user_id is not null then 'dono_humano'
               when c.lead_id is not null then 'ligada_a_negocio'
               when c.agent_case_id is not null then 'nasceu_de_caso'
               when c.estado <> 'aberta' then 'estado_avancado'
               else 'sem_vinculo'
             end
           when 'ambigua' then
             case
               when c.conversas > 1 or c.canais > 1 then 'compartilhada_entre_canais'
               when c.no_card then 'card_aponta_para_ela'
               when c.mensagens > 0 then 'referenciada_por_mensagem'
               when c.checkpoints > 0 then 'referenciada_por_checkpoint'
               else 'referenciada_por_tarefa'
             end
           else 'conversa_arquivada_sem_mais_nada'
         end as motivo
    from classificadas c
)

select categoria,
       motivo,
       organization_id,
       id as demanda_id,
       aberta_em,
       estado,
       conversas,
       canais,
       no_card,
       mensagens,
       checkpoints,
       tarefas
  from com_motivo
 order by categoria, organization_id, aberta_em, demanda_id;
