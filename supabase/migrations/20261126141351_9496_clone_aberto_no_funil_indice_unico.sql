-- manifest: Uma só cópia aberta por negócio de origem e funil de destino passa a ser fato da tabela (#5281; Achado 2 do @webtecnica no #5268). Antes do índice único, deduplica as cópias abertas que bancos antigos já têm: fica a mais antiga, o que apontava para as outras passa para ela e as outras são encerradas como perda, com o vínculo registrado. Nada é apagado.

-- A regra "uma cópia aberta por (organização, funil de destino, negócio de
-- origem)" vivia só na ordem das instruções de `fn_levar_negocio_para_funil`
-- (migration 9492), sob a trava da origem. A automação e o roteador de intenção
-- gravam a cópia fora dessa transação, e o índice da 9492 não é único: a segunda
-- cópia aberta continuava possível. Aqui ela vira índice único; os escritores de
-- fora da transação tratam o `23505` devolvendo a cópia que já existe
-- (`lib/leads/clone-com-anexos.ts`).
--
-- DEDUPLICAÇÃO (só roda se ainda não houver o índice — depois dele, duplicata é
-- impossível, e o bloco sai na primeira linha):
--
-- * Fica a cópia MAIS ANTIGA (`created_at`, desempate por `id`): é exatamente a
--   que `fn_levar_negocio_para_funil` já devolve (`order by created_at, id
--   limit 1`) — a que o produto trata como "a cópia" desde a 9492.
-- * Tudo o que aponta para as descartadas passa para a que fica: toda FK de
--   coluna única para `crm_leads(id)`, lida do catálogo (`pg_constraint`), e o
--   vínculo polimórfico `crm_lead_links (target_kind = 'lead')`. Linha que
--   colidiria com um índice único na que fica (o mesmo anexo copiado nas duas,
--   o placar de 1:1) permanece na descartada — encerrada, não apagada.
-- * O `movido_para` da origem que apontava para uma descartada passa a apontar
--   para a que fica.
-- * As descartadas são ENCERRADAS como perda na etapa de perda do próprio funil
--   (se o funil não tiver uma, só o status muda), com o motivo canônico
--   `moved_to_another_pipeline` — o que não conta como perda comercial nas
--   métricas (migration 0266): uma cópia duplicada não é um negócio perdido. A
--   verdade fica em `source_metadata.duplicata_de`.
-- * O gatilho `trg_emit_event_on_lead_change` fica desligado durante o bloco:
--   sem isso, encerrar uma duplicata emitiria `lead.lost` e as automações do
--   cliente falariam com o contato por causa de uma limpeza de dados.
--   `alter table` é transacional: se o bloco falhar, o gatilho volta ligado.
do $clone_aberto_unico$
declare
  v_mapa jsonb;
  v_alvo record;
  v_linha record;
  v_ficaram integer := 0;
begin
  if to_regclass('public.crm_leads_clone_aberto_no_funil_uidx') is not null then
    return;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('descartada', c.id, 'mantida', c.mantida)), '[]'::jsonb)
    into v_mapa
    from (
      select l.id,
             first_value(l.id) over (
               partition by l.organization_id, l.pipeline_id, l.source_metadata->'clonado_de'->>'lead_id'
               order by l.created_at, l.id
             ) as mantida
        from public.crm_leads l
       where l.status = 'open' and l.source_metadata ? 'clonado_de'
    ) c
   where c.id <> c.mantida;

  if jsonb_array_length(v_mapa) > 0 then
    alter table public.crm_leads disable trigger trg_emit_event_on_lead_change;

    for v_alvo in
      select c.conrelid::regclass as tabela, a.attname::text as coluna, 'true' as filtro
        from pg_constraint c
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        join pg_attribute r on r.attrelid = c.confrelid and r.attnum = c.confkey[1]
       where c.contype = 'f'
         and c.confrelid = 'public.crm_leads'::regclass
         and cardinality(c.conkey) = 1
         and r.attname = 'id'
      union all
      select 'public.crm_lead_links'::regclass, 'target_id', $f$t.target_kind = 'lead'$f$
    loop
      begin
        execute format(
          'update %s t set %I = m.mantida
             from jsonb_to_recordset($1) as m(descartada uuid, mantida uuid)
            where t.%I = m.descartada and %s',
          v_alvo.tabela, v_alvo.coluna, v_alvo.coluna, v_alvo.filtro
        ) using v_mapa;
      exception when unique_violation then
        for v_linha in execute format(
          'select t.ctid as linha, m.mantida
             from %s t join jsonb_to_recordset($1) as m(descartada uuid, mantida uuid)
               on t.%I = m.descartada
            where %s',
          v_alvo.tabela, v_alvo.coluna, v_alvo.filtro
        ) using v_mapa loop
          begin
            execute format('update %s set %I = $1 where ctid = $2', v_alvo.tabela, v_alvo.coluna)
              using v_linha.mantida, v_linha.linha;
          exception when unique_violation then
            v_ficaram := v_ficaram + 1;
          end;
        end loop;
      end;
    end loop;

    update public.crm_leads o
       set source_metadata = o.source_metadata || jsonb_build_object('movido_para',
             (o.source_metadata->'movido_para')
             || jsonb_build_object('lead_id', k.id, 'pipeline_id', k.pipeline_id, 'stage_id', k.stage_id))
      from jsonb_to_recordset(v_mapa) as m(descartada uuid, mantida uuid)
      join public.crm_leads k on k.id = m.mantida
     where o.source_metadata->'movido_para'->>'lead_id' = m.descartada::text;

    update public.crm_leads d
       set stage_id = coalesce((
             select s.id from public.crm_stages s
              where s.pipeline_id = d.pipeline_id and s.organization_id = d.organization_id and s.is_lost
              order by s.is_archived, s.position, s.id
              limit 1
           ), d.stage_id),
           status = 'lost',
           closed_at = now(),
           lost_reason = 'moved_to_another_pipeline',
           source_metadata = d.source_metadata || jsonb_build_object('duplicata_de', jsonb_build_object(
             'lead_id', m.mantida, 'migration', '9496'
           ))
      from jsonb_to_recordset(v_mapa) as m(descartada uuid, mantida uuid)
     where d.id = m.descartada;

    alter table public.crm_leads enable trigger trg_emit_event_on_lead_change;

    -- `warning` e não `notice`: o baseline abre com `client_min_messages = warning`.
    raise warning '9496: % cópia(s) aberta(s) duplicada(s) encerrada(s); % linha(s) ficaram na cópia encerrada por colisão de índice único',
      jsonb_array_length(v_mapa), v_ficaram;
  end if;

  -- O índice não-único da 9492 fica: apagá-lo aqui não adianta, porque o bloco
  -- dela no `baseline.sql` o recria no update seguinte.
  create unique index crm_leads_clone_aberto_no_funil_uidx
    on public.crm_leads (organization_id, pipeline_id, (source_metadata->'clonado_de'->>'lead_id'))
    where status = 'open' and source_metadata ? 'clonado_de';
end $clone_aberto_unico$;
