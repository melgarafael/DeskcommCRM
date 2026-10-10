-- ═══════════════════════════════════════════════════════════════════════════
-- 0294 — O LAÇO DE RETORNO DA PASSAGEM, e o contador que cala o cobrador.
--
-- ─── O que esta migration responde ────────────────────────────────────────
--
-- A entrega da passagem (0291, 0293) fez a IA gravar POR QUE parou, o que já
-- tentou e o que o cliente quer, e pôs esse texto na frente de quem assume. A
-- pergunta que ela ainda não respondia é a única que diz se aquilo serviu para
-- alguma coisa: **depois de a IA passar a conversa, o cliente precisou repetir
-- o que já tinha dito?**
--
-- Se o briefing chegou, a repetição cai. Se não chegou, ela não muda — e a
-- feature é decoração cara. Sem este número, a única evidência de sucesso seria
-- alguém achar o cartão bonito.
--
-- ─── POR QUE NÃO UMA TABELA DE MÉTRICA, NEM UM PAINEL NOVO ────────────────
--
-- O instrumento já existe e está calibrado: `fn_atrito_jaccard(a,b)` (0135),
-- `immutable`, com limiar `p_repeticao_min` default 0.7 escolhido para zero
-- falso positivo. `fn_atrito_metrics` já o usa para a repergunta dentro do
-- Índice de Atrito, já roda SECURITY INVOKER (logo a RLS da tabela nova vale) e
-- já devolve `jsonb` — onde acrescentar chave não quebra leitor antigo. Uma
-- tabela de agregado seria um número sincronizado por cron onde cabe uma
-- consulta, que é o anti-pattern nº 5 do CLAUDE.md.
--
-- ─── AS DUAS CHAVES, E POR QUE SÃO DUAS ──────────────────────────────────
--
--   `repeticao_pos_passagem` — numerador: passagens em que o cliente repetiu;
--   `passagens_medidas`      — denominador: passagens em que ele voltou a falar.
--
-- A razão NÃO é calculada aqui. Ela é montada em `lib/metrics/atrito.ts`, que é
-- onde mora a regra "denominador zero devolve null, nunca 0". Uma razão
-- calculada no SQL devolveria `0/0` como `null` por acaso e `0/1` como `0` por
-- acidente — e a tela não teria como distinguir "ninguém repetiu" de "ninguém
-- voltou a falar". Publicar os dois números é o que torna a régua auditável por
-- quem lê a tela, não só por quem lê este arquivo.
--
-- ⚠️ A RESSALVA QUE VIAJA COM O NÚMERO (e que a tela publica na `nota`):
-- `fn_atrito_metrics` é **SECURITY INVOKER**. Um `agent` numa organização em
-- `visibility_mode='own'` enxerga o número só das conversas dele; `manager` e
-- `admin` enxergam o da organização. Dois papéis veem números diferentes de
-- boa-fé, e quem comparar sem saber disso vai achar que um deles está errado.
--
-- ─── A SEGUNDA COISA: `cobrancas` ────────────────────────────────────────
--
-- O reconhecimento da passagem (0293) só acontece por gesto de quem CHEGOU.
-- Ninguém cobra a passagem em que ninguém chegou — e dos treze caminhos que
-- passam conversa para uma pessoa, UM nasce de caso, então o
-- `case-stale-watcher` não alcança os outros doze nem por acidente. A população
-- já foi medida num CRM em produção com o mesmo desenho de fila (2026-09-14):
-- 22 pedidos parados, o mais antigo há 17,6 dias, e ONZE deles eram gente
-- pedindo para falar com uma pessoa.
--
-- O conserto é um segundo braço no MESMO cron, e ele precisa de um lugar para
-- guardar quantas vezes já cobrou — senão o alarme nunca cala, e alarme que
-- nunca cala treina a equipe a ignorar o alarme certo. `agent_cases` tem
-- `followup_attempts` para isso; `passagens_de_atendimento` não tinha nada.
--
-- DIRC, respondida: Duplicar — não, o contador é desta linha e de mais nada;
-- Integrar — não há de onde vir (o aviso da Central não conta tentativa);
-- Referenciar — não é ponteiro; Calcular — não dá: a cobrança não deixa rastro
-- próprio em lugar nenhum, e inferi-la por idade cobraria de novo o que já foi
-- cobrado três vezes.
--
-- ─── REAPLICAÇÃO ─────────────────────────────────────────────────────────
--
-- `add column if not exists` com default (aplicável a tabela COM linhas) e
-- `create or replace function` com a MESMA assinatura. O `update.sh` de um
-- clone reaplica sem erro e sem duplicar efeito. Nenhuma constraint nova sobre
-- dados existentes ⇒ não há deduplicação prévia a fazer (regra 8 da doutrina).
--
-- O corpo de `fn_atrito_metrics` abaixo é DERIVADO do corpo vigente por script
-- (`scratchpad/onda11/montar-0294.py`), nunca redigitado: duas edições, as duas
-- provadas reversíveis ao byte antes de o arquivo ser escrito.
-- ═══════════════════════════════════════════════════════════════════════════

-- Quantas vezes o vigia já cobrou ESTA passagem. Teto de 3 no chamador
-- (`app/api/v1/cron/case-stale-watcher/route.ts`), pelo mesmo argumento de
-- `agent_cases.followup_attempts`: quem ignorou três vezes não atende no quarto.
alter table public.passagens_de_atendimento
  add column if not exists cobrancas int not null default 0;


drop function if exists public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int);

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
           count(*) filter (where status = 'lost') as perdidos
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

revoke all     on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int) from public;
revoke execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int) from anon;
grant  execute on function public.fn_atrito_metrics(uuid, timestamptz, timestamptz, int, float8, int)
  to authenticated, service_role;
