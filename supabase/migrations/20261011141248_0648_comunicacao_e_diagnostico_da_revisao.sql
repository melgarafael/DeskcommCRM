-- manifest: Comunicação por evento humano e diagnóstico privado opt-in com quotas, TTL, expurgo e isolamento.
-- DIRC: traces/ledger não armazenam pacote; conteúdo temporário UNLOGGED e fora dos dumps oficiais.
-- Não altera status de Caso nem autoriza coleta sem ativação administrativa explícita.

ALTER TABLE public.agent_inbox_items DROP CONSTRAINT IF EXISTS agent_inbox_items_kind_check;
ALTER TABLE public.agent_inbox_items add constraint agent_inbox_items_kind_check check (kind in (
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
    -- (migration 0339, doc 11 decisão B) O canal de WhatsApp em modo de teste
    -- SEM número autorizado não responde a ninguém — e o esquecimento é o
    -- defeito: as mensagens chegam no Inbox e a IA nunca fala, então quem
    -- instalou conclui que o produto está quebrado. O cron canal-mudo-watcher
    -- abre este aviso depois de 3 dias e o FECHA quando deixa de valer.
    --
    -- Entra NESTA lista, e não num bloco novo no fim do arquivo: reconstruir a
    -- mesma constraint em N blocos quebra o `update.sh` de todo clone com
    -- vocabulário posterior (lição do #159).
    'canal_mudo_sem_numero',
    -- (migration 0464) a proposta comercial: vencimento sem decisão, queda da taxa
    -- de aceite e promessa de proposta que não virou proposta.
    'proposal_expired_notice', 'proposal_acceptance_rate_drop', 'proposal_promised_not_created',
    -- (migration 0466, D3) proposta presa em 'enviando' há mais de 5min — o
    -- mesmo padrão do 'message_send_stuck', cron próprio (proposta-travada).
    'proposta_travada',
    -- (migration 0475) a IA rascunhou uma proposta e falta confirmar o modelo
    -- sugerido (plano N1) ou falta preço de catálogo — a Central acompanha
    -- até as duas pendências sumirem, ou até a proposta ser enviada/descartada.
    'proposta_pronta_para_revisao',
    -- (migration 0501) a organização voltou de uma suspensão e há conversas que
    -- receberam mensagem enquanto ela estava parada: a IA não respondeu nem vai
    -- responder sozinha. Um item por reativação, aberto por fn_reativar_organizacao.
    'org_reativada',
    -- (migration 0500) O Jev percebeu, numa mensagem em que a regra de hoje não
    -- viu nada, um pedido para falar com uma pessoa ou para parar de receber
    -- mensagens, e a empresa escolheu "Avisar a equipe". Um kind por pedido, e
    -- não `other`: a Central dá rótulo e destino por kind, e o `other` não leva
    -- a uma conversa (lib/ai/inbox-destino.ts); e o aviso é um por CONVERSA e
    -- pedido. O Jev só abre o aviso — quem passa a conversa é a regra de hoje
    -- ou uma pessoa, e quem bloqueia é só o STOP do próprio cliente. NESTA
    -- lista pelas razões de sempre (#159; a janela do `midia-nao-lida.test.ts`).
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    -- (migration 0589, issue #2389) A pausa de uma conexão era silenciosa para
    -- todo mundo menos para quem clicou. O audit registrava `channel.disabled`
    -- / `channel.enabled`, mas audit é histórico para quem procura, não
    -- comunicação — a Central é onde a operação inteira olha. O item nasce na
    -- pausa e se resolve sozinho na retomada ou no arquivamento, com o motivo
    -- no corpo (laço do canal-mudo-watcher, só que instantâneo).
    'canal_pausado',
    -- (migration 0601) a cobrança do revendedor fala com a empresa: os avisos
    -- da régua (teste acabando, venceu, suspende em breve, suspensa) nascem sem
    -- referência, e o de 80% do teto de IA do plano nasce com ref_kind plano. Os
    -- dois abrem Configurações › Plano e cobrança, só para quem administra.
    'cobranca',
    -- (migration 0614) o admin da plataforma trocou o e-mail de login de uma
    -- pessoa da equipe (PATCH .../members/[userId]/email): a empresa fica
    -- sabendo pela Central — com o nome e a data, nunca o endereço.
    'email_de_login_trocado',
    'review_capture_stopped',
    'other'
  ));

ALTER TABLE public.send_ledger ADD COLUMN IF NOT EXISTS human_event_id uuid;
-- Não retropreencher legado ambiguamente; vínculos novos são conferidos na borda de envio.
CREATE UNIQUE INDEX IF NOT EXISTS send_ledger_human_event_seq
  ON public.send_ledger(organization_id,human_event_id,seq) WHERE human_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_case_events_org_id ON public.agent_case_events(organization_id,id);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.send_ledger'::regclass AND conname='send_ledger_human_event_scope') THEN
    ALTER TABLE public.send_ledger ADD CONSTRAINT send_ledger_human_event_scope
      FOREIGN KEY(organization_id,human_event_id) REFERENCES public.agent_case_events(organization_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.review_capture_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  job_id uuid REFERENCES public.job_queue(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  collect_until timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  reviews integer NOT NULL DEFAULT 0 CHECK(reviews BETWEEN 0 AND 100),
  bytes bigint NOT NULL DEFAULT 0 CHECK(bytes BETWEEN 0 AND 10485760),
  last_purged_at timestamptz,
  stopped_reason text,
  CHECK(num_nonnulls(job_id,contact_id)=1),
  CHECK(collect_until>created_at AND collect_until<=created_at+interval '2 hours')
);
CREATE UNIQUE INDEX IF NOT EXISTS review_capture_one_active ON public.review_capture_sessions(organization_id) WHERE enabled;
CREATE INDEX IF NOT EXISTS review_capture_sessions_org_time ON public.review_capture_sessions(organization_id,created_at DESC);
CREATE UNLOGGED TABLE IF NOT EXISTS public.review_capture_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.review_capture_sessions(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.job_queue(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  caminho text NOT NULL CHECK(caminho IN ('reserva','confirmador','jev')),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  CHECK(expires_at>captured_at AND expires_at<=captured_at+interval '72 hours'),
  CHECK(octet_length(payload::text)<=10485760)
);
CREATE INDEX IF NOT EXISTS review_capture_records_expiry ON public.review_capture_records(expires_at);
CREATE INDEX IF NOT EXISTS review_capture_records_scope ON public.review_capture_records(organization_id,session_id);
ALTER TABLE public.review_capture_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_capture_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_review_capture_sessions_all ON public.review_capture_sessions;
DROP POLICY IF EXISTS tenant_isolation_review_capture_records_all ON public.review_capture_records;
-- RLS sem policy permissiva: mesmo um grant acidental não serve conteúdo direto.
-- Toda leitura passa pela rota admin e auditoria síncrona. Nem admin pode ler pelo Data API sem audit.
REVOKE ALL ON public.review_capture_sessions,public.review_capture_records FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_review_capture_enabled(p_org uuid,p_job uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.review_capture_sessions s JOIN public.job_queue j
    ON j.organization_id=s.organization_id AND j.id=p_job
    WHERE s.organization_id=p_org AND s.enabled AND s.collect_until>clock_timestamp()
    AND (s.job_id=j.id OR s.contact_id=j.contact_id))
$$;
REVOKE ALL ON FUNCTION public.fn_review_capture_enabled(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_capture_enabled(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_review_capture_append(p_org uuid,p_job uuid,p_path text,p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.review_capture_sessions%ROWTYPE; j public.job_queue%ROWTYPE;
  n bigint; result uuid; ts timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO j FROM public.job_queue WHERE id=p_job AND organization_id=p_org;
  IF NOT FOUND OR j.contact_id IS NULL OR p_path NOT IN('reserva','confirmador','jev') THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.contacts WHERE id=j.contact_id AND organization_id=p_org AND NOT is_anonymized FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.review_capture_sessions WHERE organization_id=p_org AND enabled
    AND collect_until>ts AND (job_id=p_job OR contact_id=j.contact_id)
    ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF s.last_purged_at IS NULL OR s.last_purged_at<=ts-interval '10 minutes' THEN
    UPDATE public.review_capture_sessions SET enabled=false,stopped_reason='purge_late' WHERE id=s.id;
    INSERT INTO public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
      SELECT p_org,'review_capture_stopped','warn','Diagnóstico da revisão interrompido',
        'O expurgo ficou atrasado. Revise o diagnóstico privado em Execuções de IA.',NULL,NULL
      WHERE NOT EXISTS(SELECT 1 FROM public.agent_inbox_items WHERE organization_id=p_org AND kind='review_capture_stopped' AND status='open') ON CONFLICT DO NOTHING;
    INSERT INTO public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
      VALUES(p_org,'ai.review_capture_stopped','review_capture',s.id,jsonb_build_object('reason','purge_late'));
    RETURN NULL;
  END IF;
  n:=octet_length(p_payload::text);
  IF s.reviews>=100 OR s.bytes+n>10485760 THEN
    UPDATE public.review_capture_sessions SET enabled=false,stopped_reason='quota' WHERE id=s.id;
    INSERT INTO public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
      VALUES(p_org,'ai.review_capture_stopped','review_capture',s.id,jsonb_build_object('reason','quota'));
    RETURN NULL;
  END IF;
  INSERT INTO public.review_capture_records(organization_id,session_id,job_id,contact_id,caminho,captured_at,expires_at,payload)
    VALUES(p_org,s.id,p_job,j.contact_id,p_path,ts,ts+interval '72 hours',p_payload) RETURNING id INTO result;
  UPDATE public.review_capture_sessions SET reviews=reviews+1,bytes=bytes+n WHERE id=s.id;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.fn_review_capture_append(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_capture_append(uuid,uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_review_capture_purge(p_org uuid DEFAULT NULL)
RETURNS TABLE(deleted bigint,lag_ms bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n bigint; lag bigint;
BEGIN
  PERFORM public.fn_review_capture_stop_for_purge_error(p_org,true);
  -- Last-success só avança no commit que realmente apagou conteúdo vencido.
  SELECT greatest(0,coalesce(extract(epoch FROM clock_timestamp()-min(expires_at))*1000,0))::bigint INTO lag
    FROM public.review_capture_records WHERE expires_at<=clock_timestamp() AND (p_org IS NULL OR organization_id=p_org);
  DELETE FROM public.review_capture_records WHERE expires_at<=clock_timestamp() AND (p_org IS NULL OR organization_id=p_org);
  GET DIAGNOSTICS n=ROW_COUNT;
  UPDATE public.review_capture_sessions SET last_purged_at=clock_timestamp(),
    enabled=enabled AND collect_until>clock_timestamp(),
    stopped_reason=CASE WHEN enabled AND collect_until<=clock_timestamp() THEN 'collection_ended' ELSE stopped_reason END
    WHERE p_org IS NULL OR organization_id=p_org;
  RETURN QUERY SELECT n,lag;
END $$;
REVOKE ALL ON FUNCTION public.fn_review_capture_purge(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_capture_purge(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_review_capture_anonymized()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n bigint;
BEGIN
  IF NEW.is_anonymized AND NOT OLD.is_anonymized THEN
    DELETE FROM public.review_capture_records WHERE organization_id=NEW.organization_id AND contact_id=NEW.id;
    GET DIAGNOSTICS n=ROW_COUNT;
    UPDATE public.review_capture_sessions s SET enabled=false,stopped_reason='anonymized'
      WHERE s.organization_id=NEW.organization_id AND (s.contact_id=NEW.id OR EXISTS(
        SELECT 1 FROM public.job_queue j WHERE j.organization_id=NEW.organization_id AND j.id=s.job_id AND j.contact_id=NEW.id));
    IF n>0 THEN INSERT INTO public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
      VALUES(NEW.organization_id,'ai.review_capture_purged','contact',NEW.id,jsonb_build_object('records',n,'reason','anonymized')); END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fn_review_capture_anonymized() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS review_capture_anonymized ON public.contacts;
CREATE TRIGGER review_capture_anonymized AFTER UPDATE OF is_anonymized ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.fn_review_capture_anonymized();
COMMENT ON TABLE public.review_capture_records IS 'Conteúdo privado temporário: excluir dados dos dumps; UNLOGGED evita WAL/replicação; acesso auditado admin; expurgo físico até72h com atraso medido.';

CREATE OR REPLACE FUNCTION public.fn_review_capture_stop_for_purge_error(p_org uuid DEFAULT NULL,p_only_late boolean DEFAULT false)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record; n bigint:=0;
BEGIN
  FOR s IN UPDATE public.review_capture_sessions SET enabled=false,stopped_reason=CASE WHEN p_only_late THEN 'purge_late' ELSE 'purge_failed' END
    WHERE enabled AND (p_org IS NULL OR organization_id=p_org)
      AND (NOT p_only_late OR last_purged_at IS NULL OR last_purged_at<=clock_timestamp()-interval '10 minutes')
    RETURNING id,organization_id LOOP
    n:=n+1;
    INSERT INTO public.agent_inbox_items(organization_id,kind,severity,title,body,ref_kind,ref_id)
      SELECT s.organization_id,'review_capture_stopped','warn','Diagnóstico da revisão interrompido',
        'O expurgo falhou ou ficou atrasado. Revise o diagnóstico privado em Execuções de IA.',NULL,NULL
      WHERE NOT EXISTS(SELECT 1 FROM public.agent_inbox_items WHERE organization_id=s.organization_id AND kind='review_capture_stopped' AND status='open') ON CONFLICT DO NOTHING;
    INSERT INTO public.api_audit_log(organization_id,action,resource_type,resource_id,metadata)
      VALUES(s.organization_id,'ai.review_capture_stopped','review_capture',s.id,jsonb_build_object('reason',CASE WHEN p_only_late THEN 'purge_late' ELSE 'purge_failed' END));
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fn_review_capture_stop_for_purge_error(uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_capture_stop_for_purge_error(uuid,boolean) TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS review_capture_one_notice ON public.agent_inbox_items(organization_id)
  WHERE kind='review_capture_stopped' AND status='open';
CREATE UNIQUE INDEX IF NOT EXISTS case_communication_one_notice ON public.agent_inbox_items(organization_id,ref_id)
  WHERE kind='other' AND ref_kind='agent_case' AND title='Comunicação de Caso pendente' AND status='open';

-- O service role pode chamar, mas não ler a tabela crua. RBAC/impersonação são resolvidos
-- pela rota antes da RPC; org e ator nunca vêm do body. Auditoria falha → conteúdo não sai.
CREATE OR REPLACE FUNCTION public.fn_review_capture_manage(p_org uuid,p_actor uuid,p_action text,
  p_scope uuid DEFAULT NULL,p_kind text DEFAULT NULL,p_session uuid DEFAULT NULL,p_support jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sid uuid; scope_contact uuid; result jsonb; n bigint; ts timestamptz;
BEGIN
  IF p_actor IS NULL OR p_action NOT IN('enable','revoke','status','read') THEN RETURN NULL; END IF;
  IF p_action IN('enable','revoke') AND p_support IS NOT NULL AND p_support->>'access_mode' IS DISTINCT FROM 'full' THEN RETURN NULL; END IF;
  -- Serializa ativações/revogação e impede duas sessões concorrentes contornarem quotas.
  PERFORM pg_advisory_xact_lock(hashtextextended('review_capture:'||p_org::text,0));
  PERFORM public.fn_review_capture_stop_for_purge_error(p_org,true);
  IF p_action='enable' THEN
    IF p_kind='job' THEN SELECT contact_id INTO scope_contact FROM public.job_queue WHERE organization_id=p_org AND id=p_scope;
    ELSIF p_kind='test_contact' THEN scope_contact:=p_scope;
    ELSE RETURN NULL; END IF;
    PERFORM 1 FROM public.contacts WHERE organization_id=p_org AND id=scope_contact AND NOT is_anonymized FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- Revogar a captura anterior também remove seu conteúdo, sem reaproveitar TTL/contador.
    UPDATE public.review_capture_sessions SET enabled=false,stopped_reason='replaced' WHERE organization_id=p_org AND enabled;
    DELETE FROM public.review_capture_records WHERE organization_id=p_org;
    GET DIAGNOSTICS n=ROW_COUNT;
    PERFORM public.fn_review_capture_purge(p_org);
    -- Um mesmo instante ancora o teto; chamadas volateis separadas podem violar o CHECK.
    ts:=clock_timestamp();
    INSERT INTO public.review_capture_sessions(organization_id,actor_user_id,job_id,contact_id,created_at,collect_until,enabled,last_purged_at)
      VALUES(p_org,p_actor,CASE WHEN p_kind='job' THEN p_scope END,CASE WHEN p_kind='test_contact' THEN p_scope END,
        ts,ts+interval '2 hours',true,ts) RETURNING id INTO sid;
    INSERT INTO public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata)
      VALUES(p_org,p_actor,'ai.review_capture_enabled','review_capture',sid,
        jsonb_build_object('scope_kind',p_kind,'records_purged',n,'support',p_support));
    UPDATE public.agent_inbox_items SET status='resolved',resolved_at=now() WHERE organization_id=p_org AND kind='review_capture_stopped' AND status='open';
    RETURN jsonb_build_object('session_id',sid,'enabled',true);
  ELSIF p_action='revoke' THEN
    SELECT id INTO sid FROM public.review_capture_sessions WHERE organization_id=p_org AND id=p_session FOR UPDATE;
    IF sid IS NULL THEN RETURN NULL; END IF;
    UPDATE public.review_capture_sessions SET enabled=false,stopped_reason='revoked' WHERE id=sid;
    DELETE FROM public.review_capture_records WHERE organization_id=p_org AND session_id=sid;
    GET DIAGNOSTICS n=ROW_COUNT;
    INSERT INTO public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata)
      VALUES(p_org,p_actor,'ai.review_capture_purged','review_capture',sid,jsonb_build_object('reason','revoked','records',n,'support',p_support));
    RETURN jsonb_build_object('session_id',sid,'enabled',false,'deleted',n);
  ELSIF p_action='read' THEN
    IF NOT EXISTS(SELECT 1 FROM public.review_capture_sessions WHERE organization_id=p_org AND id=p_session) THEN RETURN NULL; END IF;
    INSERT INTO public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata)
      VALUES(p_org,p_actor,'ai.review_capture_read','review_capture',p_session,jsonb_build_object('support',p_support));
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'caminho',r.caminho,'captured_at',r.captured_at,
      'expires_at',r.expires_at,'job_id',r.job_id,'payload',r.payload) ORDER BY r.captured_at),'[]'::jsonb) INTO result
      FROM public.review_capture_records r WHERE r.organization_id=p_org AND r.session_id=p_session AND r.expires_at>clock_timestamp();
    RETURN jsonb_build_object('records',result);
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC),'[]'::jsonb) INTO result FROM(
    SELECT id,job_id,contact_id,created_at,collect_until,enabled AND collect_until>clock_timestamp() AS enabled,
      reviews,bytes,last_purged_at,stopped_reason FROM public.review_capture_sessions WHERE organization_id=p_org
      ORDER BY created_at DESC LIMIT 20)s;
  RETURN jsonb_build_object('sessions',result,'default_enabled',false);
END $$;
REVOKE ALL ON FUNCTION public.fn_review_capture_manage(uuid,uuid,text,uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_capture_manage(uuid,uuid,text,uuid,text,uuid,jsonb) TO service_role;
