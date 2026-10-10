-- 0326 — a reconciliação de duas branches represadas que tocaram os MESMOS objetos
--
-- Por que esta migration existe, e por que ela não é "arrumação":
--
-- Esta branch (casos vivos) nasceu antes de 0310-0323 e ficou represada. Enquanto
-- isso, duas migrations da `main` reconstruíram objetos que ela também estende:
--
--   · 0312 refez `agent_inbox_items_kind_check` SEM `aviso_de_caso_nao_entregue`
--     (o kind que a 0292 acrescentou) — um clone que aplica a CADEIA ficaria sem
--     ele, e todo aviso de caso não entregue seria recusado pelo CHECK;
--   · 0322 redefiniu `fn_atrito_metrics` SEM `repeticao_pos_passagem` e
--     `passagens_medidas` (o laço de retorno da 0294) — o painel de atrito
--     perderia a medida que diz se a passagem para humano serviu de alguma coisa.
--
-- Nenhum dos dois lados errou: cada um reconstruiu o objeto a partir do estado que
-- via. O defeito é do ENCONTRO, e por isso o conserto é forward-fix — editar 0312
-- ou 0322 quebraria quem já as aplicou (doutrina de migrations do CLAUDE.md).
--
-- O que esta migration afirma é a UNIÃO, medida e não inferida:
--   CHECK ............. os 28 valores de 0312 + `aviso_de_caso_nao_entregue` = 29
--   fn_atrito_metrics . o corpo de 0322 (com `envios_por_automacao`,
--                       `envios_por_integracao` e a regra de
--                       `moved_to_another_pipeline` da 0266) MAIS o bloco do laço
--                       de retorno da 0294.
--
-- Idempotente: `drop constraint if exists` + `add constraint`, e
-- `create or replace function`. Reaplicar não duplica efeito.
--
-- ⚠️ ESTE ARQUIVO FOI EDITADO DEPOIS DE ENTRAR NA `main` — e é a exceção
-- consciente à regra "nunca edite migration aplicada". Na primeira versão, o
-- parágrafo acima prometia o `drop constraint if exists` e o SQL não o tinha. A
-- constraint existe desde a 0050 (CHECK de coluna, batizado pelo Postgres), então
-- o `add` falhava com 42710 (already exists) em TODO banco que segue a cadeia, e
-- a aplicação parava aqui: nenhuma migration posterior a esta, na ordem dos
-- nomes de arquivo, rodava.
--
-- Por que editar e não fazer forward-fix: a forward-fix viria DEPOIS desta, e a
-- cadeia nunca chega nela. Por que editar é seguro: pelo mesmo motivo, esta
-- migration não tem como ter rodado com sucesso em banco nenhum que siga a
-- cadeia — não há clone que "já a aplicou" para ser surpreendido. Quem a tem
-- registrada como aplicada por outro caminho (`migration repair`) não a roda de
-- novo; quem ainda não a aplicou, agora consegue. O kit self-host nunca foi
-- afetado: ele aplica o `baseline.sql`, onde o bloco sempre foi drop + add.
--
-- A reprodução (19/09/2026, `pgvector/pgvector:pg17` com o prelude de
-- scripts/test-db.sh, `psql -v ON_ERROR_STOP=1`):
--
--     baseline.sql (install) ........................ rc=0
--     esta migration SEM o drop (a versão anterior) .. rc=3  ERROR: constraint
--         "agent_inbox_items_kind_check" for relation "agent_inbox_items"
--         already exists
--     esta migration COM o drop ...................... rc=0, 29 kinds
--     reaplicada ..................................... rc=0
--
-- NÃO MEDIDO: se alguma instância do mantenedor aplica a cadeia (MCP
-- `apply_migration` ou `supabase db push`). Se aplicou, falhou aqui e alguém
-- contornou à mão, o que rodou lá difere deste arquivo — confira em
-- `select version from supabase_migrations.schema_migrations where version = '20260919150500'`.
--
-- A cerca que teria pegado isto: tests/unit/reconstruir-constraint-derruba-antes.test.ts.

-- ---- 1. o CHECK com os dois vocabulários ----

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    -- (migration 0109, issue #129) Mensagem outbound nasce `sending` e, quando o
    -- envio nunca acontece, fica `sending` para sempre — o self-hoster vê uma
    -- mensagem eternamente "enviando", sinal de progresso para algo que não vai
    -- acontecer. O cron `recover-stuck-messages` marca `failed` e usa este kind
    -- para o defeito APARECER na Central de avisos.
    --
    -- Entra NESTA lista, e não num bloco novo no fim do arquivo: o #159 do @jmpo
    -- mostrou que reconstruir a mesma constraint em N blocos quebra o
    -- `update.sh` de todo clone que já tenha uma linha de vocabulário posterior
    -- — os blocos antigos rodam antes e falham em cadeia. Um bloco por
    -- constraint, vigiado por tests/unit/baseline-constraint-reconstruida.test.ts.
    'message_send_stuck',
    -- (migration 0129) O cliente manda foto/áudio e o agente age como se nada
    -- tivesse chegado. Acontece quando o modelo configurado não enxerga imagem,
    -- ou quando falta a chave de transcrição — e antes disto a derivação
    -- devolvia string vazia EM SILÊNCIO: nenhum erro, nenhum log, e o operador
    -- concluindo que o agente ignorou o cliente de propósito.
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    -- (migration 0111, spec 16 §3.2) O papel Operador declara promessa em aberto:
    -- o assistente prometeu algo ao cliente e o cumprimento não foi registrado.
    -- A invariante sagrada da spec é "nenhuma promessa deixa de ser cumprida", e
    -- uma promessa sem dono precisa aparecer onde o humano olha — não no log do
    -- worker. Entra NESTA lista pela mesma razão que a de cima.
    'promise_unfulfilled',
    -- (migration 0124, spec 17 §4b) Dado que o assistente ouviu na conversa e
    -- ninguém confirmou até o prazo. `info`, não `warn`: nada quebrou — uma
    -- informação não foi aproveitada, e tratar isso como falha ensinaria a
    -- ignorar os avisos que são falha de verdade. Entra NESTA lista pela mesma
    -- razão das de cima (bloco único por constraint, #159).
    'contact_proposal_expired',
    -- (migration 0159) O gasto passou do aviso que a pessoa definiu e a IA
    -- CONTINUA respondendo — `warn`, nunca `critical`, e um kind SEPARADO de
    -- `budget_exceeded`: colapsar os dois faria o alerta de "parou" perder o
    -- significado. É este kind que torna possível a condição do gate "ninguém é
    -- bloqueado sem ter sido avisado no mês" — sem ele, o salto de 79% para 101%
    -- entre duas chamadas calaria a IA sem nenhum sinal anterior.
    --
    -- Entra NESTA lista, e AQUI no fim, por duas razões distintas: bloco único
    -- por constraint (#159), e porque `tests/unit/midia-nao-lida.test.ts` procura
    -- `'midia_nao_lida'` nos primeiros 2000 caracteres a partir do `add
    -- constraint` — um valor comentado inserido ACIMA dele empurra-o para fora da
    -- janela e reprova um teste que não tem nada a ver com o kind novo (medido:
    -- offset 1532 -> 2275). Kind novo entra no fim da lista.
    'budget_warning',
    -- (migration 0181) O material que a pessoa enviou não entrou na base: falta
    -- chave de embedding, a extração do arquivo falhou, ou nenhum trecho foi
    -- gravado. Antes disto o worker devolvia `skipped` para o próprio log, o drain
    -- tratava `skipped` como sucesso, e a linha da fonte seguia dizendo `ready`.
    -- Irmão direto de `midia_nao_lida`: mesma chave, mesmo silêncio.
    'conhecimento_nao_indexado',
    -- (migration 0206, spec 18) Chamada de voz WhatsApp (WaCalls) recebida que
    -- nunca teve answered_at — o "chamou e ninguém atendeu" precisa de dono,
    -- mesma razão de midia_nao_lida/conhecimento_nao_indexado. Entra NESTA
    -- lista, não em bloco novo (#159, bloco único por constraint).
    'voice_call_missed',
    'case_stale',
    -- (migration 0292) O aviso de caso não chegou ao WhatsApp da equipe,
    -- em definitivo. Nasce com `ref_kind='agent_case'` para levar AO CASO —
    -- que continua esperando — e não a uma tela genérica. A fonte da verdade
    -- sobre "o aviso saiu?" continua sendo `entregas_de_aviso_de_caso`:
    -- qualquer membro apaga um item da Central pelo PostgREST hoje.
    'aviso_de_caso_nao_entregue',
    -- (migration 0312) O fluxo de follow-up publicado que NUNCA vai disparar:
    -- gatilho automático (silêncio, etapa, caso, falta) só cria inscrição se
    -- algum agente publicado arma o ponteiro, e sem esse vínculo os produtores
    -- saem por `pointers_armados = 0` em silêncio — `active` na tela, morto no
    -- motor. Entra NESTA lista e no FIM dela, pelas duas razões de sempre
    -- (bloco único por constraint, #159; e a janela de 2000 caracteres que
    -- `tests/unit/midia-nao-lida.test.ts` varre a partir do `add constraint`).
    'followup_sem_agente',
    'other'
  ));


-- ---- 2. fn_atrito_metrics com as duas medidas ----

create or replace function public.fn_atrito_metrics(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_abandono_horas int default 72,
  p_repeticao_min float8 default 0.7,
  p_espera_horas int default 4
) returns jsonb
language sql stable
set search_path = public
as $$
  with
  -- DENOMINADOR DEFINITIVO: demandas encerradas na janela. Não mais os casos.
  demandas_j as (
    select d.id, d.agent_case_id, d.aberta_em, d.fechada_em, d.desfecho
      from public.demandas d
     where d.organization_id = p_org
       and d.fechada_em is not null
       and d.fechada_em >= p_from
       and d.fechada_em <  p_to
  ),
  -- Turnos: mensagens de TODAS as conversas da demanda (N:N), dentro da vida
  -- dela. Uma demanda que atravessou dois canais soma os dois.
  turnos as (
    select d.id,
           (select count(*)
              from public.demanda_conversas dc
              join public.messages m
                on m.conversation_id = dc.conversation_id
               and m.organization_id = p_org
               and m.sent_at >= d.aberta_em
               and m.sent_at <  d.fechada_em
             where dc.demanda_id = d.id) as n
      from demandas_j d
  ),
  -- Insistência: só existe onde houve caso. O payload declara o denominador
  -- próprio (`demandas_com_caso`) para o número não ser lido como se fosse
  -- sobre o total.
  insistencia as (
    select avg(c.followup_attempts)::float8 as media,
           max(c.followup_attempts)         as maximo,
           count(*)                         as base
      from demandas_j d
      join public.agent_cases c on c.id = d.agent_case_id
  ),
  humano as (
    select e.case_id, count(*) as intervencoes, min(e.created_at) as primeiro_toque
      from public.agent_case_events e
      join demandas_j d on d.agent_case_id = e.case_id
     where e.organization_id = p_org and e.actor_kind = 'human'
     group by e.case_id
  ),
  espera_fila as (
    select extract(epoch from (h.primeiro_toque - d.aberta_em)) as segundos
      from demandas_j d join humano h on h.case_id = d.agent_case_id
     where h.primeiro_toque > d.aberta_em
  ),
  retrabalho as (
    select count(distinct e.case_id) as n
      from public.agent_case_events e
      join demandas_j d on d.agent_case_id = e.case_id
     where e.organization_id = p_org
       and (e.kind = 'escalated' or e.human_action = 'escalate')
  ),
  abandono as (
    select
      count(*) filter (
        where cv.last_outbound_at >= p_from and cv.last_outbound_at < p_to
          and (cv.last_inbound_at is null or cv.last_outbound_at > cv.last_inbound_at)
          and cv.last_outbound_at < now() - make_interval(hours => p_abandono_horas)
          and cv.status not in ('resolved', 'closed')
      ) as abandonadas,
      count(*) filter (
        where cv.last_outbound_at >= p_from and cv.last_outbound_at < p_to
      ) as com_fala_nossa
      from public.conversations cv
     where cv.organization_id = p_org and cv.last_outbound_at is not null
  ),
  -- INVARIANTE 4, agora VERIFICÁVEL: demanda aberta sem próximo passo é o
  -- vazamento que a doutrina proíbe. Antes da 0119 isto não era enumerável.
  sem_proximo_passo as (
    select count(*) as n
      from public.demandas d
     where d.organization_id = p_org
       and d.fechada_em is null
       and d.proximo_passo is null
  ),
  demandas_abertas as (
    select count(*) as n from public.demandas d
     where d.organization_id = p_org and d.fechada_em is null
  ),
  inbounds as (
    select m.conversation_id, m.sent_at, m.body,
           lag(m.body)    over (partition by m.conversation_id order by m.sent_at) as body_anterior,
           lag(m.sent_at) over (partition by m.conversation_id order by m.sent_at) as sent_at_anterior
      from public.messages m
     where m.organization_id = p_org and m.direction = 'inbound' and m.body is not null
       and m.sent_at >= p_from and m.sent_at < p_to
  ),
  repeticao as (
    select
      count(*) filter (
        where i.body_anterior is not null
          and exists (select 1 from public.messages o
                       where o.organization_id = p_org and o.conversation_id = i.conversation_id
                         and o.direction = 'outbound'
                         and o.sent_at > i.sent_at_anterior and o.sent_at < i.sent_at)
          and public.fn_atrito_jaccard(i.body, i.body_anterior) >= p_repeticao_min
      ) as repetidas,
      count(*) filter (
        where i.body_anterior is not null
          and exists (select 1 from public.messages o
                       where o.organization_id = p_org and o.conversation_id = i.conversation_id
                         and o.direction = 'outbound'
                         and o.sent_at > i.sent_at_anterior and o.sent_at < i.sent_at)
      ) as com_resposta_no_meio
      from inbounds i
  ),
  espera_calada as (
    select count(*) filter (where prox.espera_s > p_espera_horas * 3600) as caladas,
           count(*) as com_resposta,
           percentile_cont(0.9) within group (order by prox.espera_s) as p90_s
      from (
        select extract(epoch from (
                 (select min(o.sent_at) from public.messages o
                   where o.organization_id = p_org and o.conversation_id = m.conversation_id
                     and o.direction = 'outbound' and o.sent_at > m.sent_at) - m.sent_at)) as espera_s
          from public.messages m
         where m.organization_id = p_org and m.direction = 'inbound'
           and m.sent_at >= p_from and m.sent_at < p_to
      ) prox
     where prox.espera_s is not null
  ),
  envios as (
    select count(*) filter (where m.sent_via = 'ai')              as por_ia,
           count(*) filter (where m.sent_via = 'automation')      as por_automacao,
           count(*) filter (where m.sent_via = 'system')          as por_integracao,
           count(*) filter (where m.sent_via = 'user')            as por_humano_no_sistema,
           count(*) filter (where m.sent_via = 'external_device') as por_humano_fora
      from public.messages m
     where m.organization_id = p_org and m.direction = 'outbound'
       and m.sent_at >= p_from and m.sent_at < p_to
  ),
  vetos as (
    select count(*) filter (where t.vetoed_gate is not null) as vetados,
           count(distinct t.job_id) as execucoes
      from public.before_send_traces t
     where t.organization_id = p_org and t.created_at >= p_from and t.created_at < p_to
  ),
  descadastros as (
    select count(*) as n from public.contacts c
     where c.organization_id = p_org and c.blocked_at is not null
       and c.blocked_at >= p_from and c.blocked_at < p_to
  ),
  pedidos_humano as (
    select count(*) as n from public.crm_lead_activities a
     where a.organization_id = p_org and a.type = 'handoff_triggered'
       and a.performed_at >= p_from and a.performed_at < p_to
  ),
  -- ─── O LAÇO DE RETORNO DA PASSAGEM (migration 0294) ──────────────────────
  -- A pergunta que mede se o briefing serviu para alguma coisa: DEPOIS de a IA
  -- passar a conversa, o cliente precisou repetir o que já tinha dito? Se o
  -- contexto chegou a quem assumiu, a repetição cai; se não chegou, ela não
  -- muda — e a feature é decoração.
  --
  -- A RÉGUA, escrita para o número não envelhecer:
  --   · limiar         = `p_repeticao_min` (0.7), o MESMO do índice de
  --                      repergunta — dois limiares para o mesmo fenômeno
  --                      fariam dois números incomparáveis na mesma tela;
  --   · janela         = 24 h depois da passagem. Mais que isso já é outra
  --                      conversa; menos deixaria de fora o atendente que
  --                      assumiu no dia seguinte;
  --   · denominador    = passagens em que o cliente VOLTOU A FALAR. Sem fala
  --                      nova não há repetição a medir, e contá-las como "não
  --                      repetiu" inflaria o número para o lado bonito. É a
  --                      mesma regra de `lib/metrics/atrito.ts`: ausência de
  --                      dado é `null`, nunca `0` — e é a razão de as DUAS
  --                      chaves saírem daqui (numerador e denominador), em vez
  --                      de uma razão já calculada.
  repeticao_pos_passagem as (
    select count(*) filter (where r.repetiu) as repetidas,
           count(*)                          as medidas
      from (
        select p.id,
               exists (
                 select 1
                   from public.messages depois
                   join public.messages antes
                     on antes.organization_id = depois.organization_id
                    and antes.conversation_id = depois.conversation_id
                    and antes.direction = 'inbound'
                    and antes.body is not null
                    and antes.sent_at < p.criado_em
                  where depois.organization_id = p.organization_id
                    and depois.conversation_id = p.conversation_id
                    and depois.direction = 'inbound'
                    and depois.body is not null
                    and depois.sent_at > p.criado_em
                    and depois.sent_at < p.criado_em + interval '24 hours'
                    and public.fn_atrito_jaccard(depois.body, antes.body) >= p_repeticao_min
               ) as repetiu
          from public.passagens_de_atendimento p
         where p.organization_id = p_org
           and p.criado_em >= p_from and p.criado_em < p_to
           and exists (
             select 1 from public.messages m
              where m.organization_id = p.organization_id
                and m.conversation_id = p.conversation_id
                and m.direction = 'inbound'
                and m.body is not null
                and m.sent_at > p.criado_em
                and m.sent_at < p.criado_em + interval '24 hours'
           )
      ) r
  ),
  eficiencia as (
    select count(*) filter (where status = 'won')  as ganhos,
           count(*) filter (
             where status = 'lost'
               -- A transferência entre funis não é perda comercial (migration 0266).
               and coalesce(lost_reason, '') <> 'moved_to_another_pipeline'
           ) as perdidos
      from public.crm_leads
     where organization_id = p_org and status in ('won', 'lost')
       and closed_at >= p_from and closed_at < p_to
  )
  select jsonb_build_object(
    'escopo', jsonb_build_object(
      'demandas',            (select count(*) from demandas_j),
      'demandas_com_caso',   (select base from insistencia),
      'demandas_abertas',    (select n from demandas_abertas),
      'de', p_from, 'ate', p_to,
      'abandono_horas', p_abandono_horas,
      'repeticao_min',  p_repeticao_min,
      'espera_horas',   p_espera_horas,
      -- Marca a régua do denominador: quem comparar dois períodos precisa saber
      -- se foram medidos sobre casos ou sobre demandas.
      'denominador', 'demandas'
    ),
    'cliente', jsonb_build_object(
      'turnos_p50',        (select percentile_cont(0.5) within group (order by n) from turnos),
      'turnos_p90',        (select percentile_cont(0.9) within group (order by n) from turnos),
      'insistencia_media', (select media  from insistencia),
      'insistencia_max',   (select maximo from insistencia),
      'pedidos_de_humano', (select n from pedidos_humano),
      'descadastros',      (select n from descadastros),
      'abandonos',         (select abandonadas   from abandono),
      'conversas_com_fala_nossa', (select com_fala_nossa from abandono),
      'reperguntas',              (select repetidas            from repeticao),
      'perguntas_com_resposta',   (select com_resposta_no_meio from repeticao),
      'esperas_caladas',          (select caladas      from espera_calada),
      'esperas_medidas',          (select com_resposta from espera_calada),
      'espera_resposta_p90_s',    (select p90_s        from espera_calada),
      -- As duas chaves do laço da passagem (0294). Numerador e denominador
      -- SEPARADOS de propósito: a razão é calculada na borda, que é onde
      -- mora a regra de devolver `null` quando o denominador é zero.
      'repeticao_pos_passagem',   (select repetidas from repeticao_pos_passagem),
      'passagens_medidas',        (select medidas   from repeticao_pos_passagem)
    ),
    'empresa', jsonb_build_object(
      'intervencoes_por_demanda', (select avg(coalesce(h.intervencoes, 0))::float8
                                     from demandas_j d left join humano h on h.case_id = d.agent_case_id),
      'espera_humana_p50_s',      (select percentile_cont(0.5) within group (order by segundos) from espera_fila),
      'espera_humana_p90_s',      (select percentile_cont(0.9) within group (order by segundos) from espera_fila),
      'retrabalho',               (select n from retrabalho),
      'vetos',                    (select vetados  from vetos),
      'execucoes_medidas',        (select execucoes from vetos),
      'envios_por_ia',            (select por_ia                from envios),
      'envios_por_automacao',     (select por_automacao         from envios),
      'envios_por_integracao',    (select por_integracao        from envios),
      'envios_humano_no_sistema', (select por_humano_no_sistema from envios),
      'envios_humano_fora',       (select por_humano_fora       from envios),
      -- O invariante 4 vira NÚMERO na tela: demanda aberta sem próximo passo é
      -- vazamento, e vazamento invisível é o que a doutrina inteira combate.
      'demandas_sem_proximo_passo', (select n from sem_proximo_passo)
    ),
    'eficiencia', jsonb_build_object(
      'ganhos',   (select ganhos   from eficiencia),
      'perdidos', (select perdidos from eficiencia)
    )
  );
$$;
