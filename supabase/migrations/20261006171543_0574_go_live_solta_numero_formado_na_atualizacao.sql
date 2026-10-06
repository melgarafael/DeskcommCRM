-- manifest: **A atualização solta sozinha a trava de número novo do número que já está formado (PR #2327, de @Sandersono; decisão do dono, doc 109, opção A).** O #2327 faz a trava de go-live segurar de verdade os retornos automáticos (`followup_turn`), que até então ela nunca retinha. Sem esta transição, quem atualizasse teria TODO número com o item de go-live aberto parado, inclusive os que operam há meses. `fn_go_live_solta_numero_formado` solta a trava (`health_released_at`) — ou, no número que ainda não tem linha de saúde (ela só nasce no primeiro aviso de conexão), cria a linha já liberada —, fecha o item da Central (`kind 'other'`, `ref_kind 'number_health'`) e grava `channel.go_live_liberado_na_atualizacao` com o motivo, para o número em que (a) o controle de ritmo já não põe limite de aquecimento — a mesma régua de `lib/agent-engine/pacing/engine.ts` sobre `channel_knobs` (idade ≥ 31 dias, "pular o aquecimento" ou degraus próprios que terminam em "sem limite") — ou (b) a primeira mensagem de saída que saiu de verdade tem ≥ 31 dias. Nunca toca trava de saúde (`block_rate`/`response_rate`, que só existe com `health_released_at` preenchido). Roda UMA vez por instalação: a marca é a linha `channel.go_live_transicao_da_atualizacao` no audit log, com a contagem. Apêndice igual no `baseline.sql`, antes da VARREDURA anon.

-- ============================================================================
-- 0574 — A TRAVA DE NÚMERO NOVO SAI SOZINHA DO NÚMERO JÁ FORMADO (#2327, doc 109)
--
-- Todo número nasce com a trava de go-live (`lib/agent-engine/health/circuit.ts`),
-- que só sai quando alguém resolve o item na Central. Até o #2327 ela não
-- retinha retorno automático nenhum; com ele, retém. Quem atualiza não pode
-- acordar com todo retorno automático parado por uma trava que nunca valeu.
--
-- ─── Qual número sai ─────────────────────────────────────────────────────────
--
-- (a) O que o controle de ritmo já considera formado. É a régua que o sistema
--     JÁ aplica para limitar o envio, copiada aqui por partes (cada trecho diz
--     de qual função veio), e `tests/invariants/go-live-solta-numero-formado`
--     a compara com as funções do motor. Ela ouve o que o operador declarou na
--     tela de ritmo: "Este número é usado desde" e "pular o aquecimento".
-- (b) Reforço para quem nunca abriu essa tela: a primeira mensagem de saída
--     que saiu de verdade (enviada, entregue ou lida) tem 31 dias ou mais —
--     o mesmo ponto em que o ritmo para de limitar.
--
-- A marca `is_warmup_complete` NÃO serve: ninguém grava `warmup_started_at`,
-- então ela é sempre falsa numa instalação real (doc 109).
--
-- ─── O que NÃO acontece ──────────────────────────────────────────────────────
--
-- Trava de saúde ruim (`block_rate`, `response_rate`) nunca sai daqui: ela só
-- existe em número já liberado (`health_released_at` preenchido), que o filtro
-- exclui. Número que não cumpre (a) nem (b) continua travado: os retornos dele
-- esperam na fila até alguém liberar na Central, e o item da Central passa a
-- dizer isso com nível "aviso" (circuit.ts).
--
-- ─── Uma vez por instalação ──────────────────────────────────────────────────
--
-- O `update.sh` reaplica o baseline a cada atualização. Sem a marca, um número
-- conectado DEPOIS desta versão sairia da trava numa atualização qualquer, sem
-- ato de ninguém — e a trava existe justamente para só sair por ato explícito.
-- A marca é a linha de auditoria da rodada; se a retenção do audit log um dia
-- a apagar (piso de 90 dias), a regra roda mais uma vez, com o mesmo critério.
-- Chamar a função duas vezes não muda nada: o número solto deixa de casar.
-- ============================================================================

create or replace function public.fn_go_live_solta_numero_formado()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_soltos integer;
begin
  with candidatos as (
    select s.organization_id,
           s.id as channel_session_id,
           s.status,
           -- `parseWarmupCaps` + `PACING_DEFAULTS.warmupDailyCaps`: degrau inválido
           -- ou ausente cai no padrão conservador, como no motor.
           case
             when jsonb_typeof(k.warmup_daily_caps) = 'array'
              and jsonb_array_length(k.warmup_daily_caps) > 0
              and not exists (
                select 1 from jsonb_array_elements(k.warmup_daily_caps) e
                 where jsonb_typeof(e) <> 'object'
                    or coalesce(jsonb_typeof(e -> 'minAgeDays'), '') <> 'number'
                    or coalesce(jsonb_typeof(e -> 'cap'), '') not in ('null', 'number'))
             then k.warmup_daily_caps
             else '[{"minAgeDays":0,"cap":20},{"minAgeDays":4,"cap":50},{"minAgeDays":8,"cap":100},{"minAgeDays":15,"cap":200},{"minAgeDays":31,"cap":null}]'::jsonb
           end as degraus,
           -- `decidePacing`: dias completos desde a ativação, nunca negativo; sem
           -- linha de ritmo, idade 0.
           coalesce(greatest(0, floor(extract(epoch from (now() - k.number_activated_at)) / 86400)), 0) as idade
      -- Parte da SESSÃO, não da linha de saúde: a linha só nasce no primeiro
      -- aviso de conexão (`lib/channels/health.ts`). Número formado sem ela não
      -- está travado hoje, mas seria travado como "novo" no primeiro aviso —
      -- depois de a marca de rodada única já ter fechado esta transição.
      from channel_sessions s
      left join channel_session_health h
        on h.organization_id = s.organization_id and h.channel_session_id = s.id
      left join channel_knobs k
        on k.organization_id = s.organization_id and k.channel_session_id = s.id
     where h.health_released_at is null
       and coalesce(h.health_hold_reason, 'go_live') = 'go_live'
  ),
  formados as (
    select c.organization_id,
           c.channel_session_id,
           c.status,
           case
             -- `warmupCapFor`: o ÚLTIMO degrau alcançado pela idade; aquém do
             -- primeiro, o primeiro. `cap` null = sem limite de aquecimento.
             when coalesce(
                    (select e -> 'cap'
                       from jsonb_array_elements(c.degraus) with ordinality as t(e, i)
                      where (e ->> 'minAgeDays')::numeric <= c.idade
                      order by i desc
                      limit 1),
                    c.degraus -> 0 -> 'cap') = 'null'::jsonb
               then 'ritmo_sem_limite_de_aquecimento'
             when exists (
                    select 1 from messages m
                     where m.organization_id = c.organization_id
                       and m.channel_session_id = c.channel_session_id
                       and m.direction = 'outbound'
                       and m.status in ('sent', 'delivered', 'read')
                       and m.sent_at <= now() - interval '31 days')
               then 'primeira_saida_ha_31_dias_ou_mais'
           end as motivo
      from candidatos c
  ),
  -- Sem linha de saúde, nasce uma já liberada; com linha, ela é solta. O
  -- `where` do conflito é a segunda guarda da trava de saúde.
  liberados as (
    insert into channel_session_health (organization_id, channel_session_id, status, health_released_at)
    select f.organization_id, f.channel_session_id, f.status, now()
      from formados f
     where f.motivo is not null
    on conflict (organization_id, channel_session_id) do update
       set health_released_at = now(),
           health_hold_active = false,
           health_hold_reason = null,
           updated_at = now()
     where channel_session_health.health_released_at is null
    returning organization_id, channel_session_id
  ),
  soltos as (
    select l.organization_id, l.channel_session_id, f.motivo
      from liberados l
      join formados f
        on f.organization_id = l.organization_id and f.channel_session_id = l.channel_session_id
  ),
  fechados as (
    update agent_inbox_items i
       set status = 'resolved', resolved_at = now()
      from soltos s
     where i.organization_id = s.organization_id
       and i.kind = 'other'
       and i.ref_kind = 'number_health'
       and i.ref_id = s.channel_session_id
       and i.status in ('open', 'ack')
    returning i.organization_id, i.ref_id
  ),
  auditados as (
    insert into api_audit_log (organization_id, action, resource_type, resource_id, metadata, bypassed_rls)
    select s.organization_id,
           'channel.go_live_liberado_na_atualizacao',
           'channel_session',
           s.channel_session_id,
           jsonb_build_object(
             'motivo', s.motivo,
             'itens_fechados', (select count(*) from fechados f
                                 where f.organization_id = s.organization_id
                                   and f.ref_id = s.channel_session_id)),
           true
      from soltos s
    returning 1
  )
  select count(*) into v_soltos from auditados;
  return v_soltos;
end;
$$;

revoke execute on function public.fn_go_live_solta_numero_formado() from public, anon, authenticated, service_role;

-- Uma vez por instalação: a marca é a própria linha de auditoria da rodada.
do $$
declare
  v_soltos integer;
begin
  if not exists (
    select 1 from public.api_audit_log where action = 'channel.go_live_transicao_da_atualizacao'
  ) then
    v_soltos := public.fn_go_live_solta_numero_formado();
    insert into public.api_audit_log (organization_id, action, resource_type, metadata, bypassed_rls)
    values (null, 'channel.go_live_transicao_da_atualizacao', 'channel_session_health',
            jsonb_build_object('numeros_liberados', v_soltos), true);
  end if;
end;
$$;
