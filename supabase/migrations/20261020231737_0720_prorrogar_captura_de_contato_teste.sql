-- manifest: Prorrogação explícita e auditada da captura de contato de teste, sem renovar TTL ou cotas.
-- O padrão continua 2h. Somente contato de teste pode ter extensão até 48h desde a criação.
ALTER TABLE public.review_capture_sessions DROP CONSTRAINT IF EXISTS review_capture_sessions_check1;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.review_capture_sessions'::regclass
    AND conname='review_capture_sessions_collection_window_check') THEN
    ALTER TABLE public.review_capture_sessions ADD CONSTRAINT review_capture_sessions_collection_window_check
      CHECK(collect_until>created_at AND collect_until<=created_at+
        CASE WHEN contact_id IS NOT NULL AND job_id IS NULL THEN interval '48 hours' ELSE interval '2 hours' END);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_review_capture_extend_test_contact(
  p_org uuid,p_actor uuid,p_session uuid,p_until timestamptz,p_support jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.review_capture_sessions%ROWTYPE; scope_contact uuid; ts timestamptz;
BEGIN
  IF p_actor IS NULL OR p_until IS NULL OR NOT isfinite(p_until) OR
    (p_support IS NOT NULL AND p_support->>'access_mode' IS DISTINCT FROM 'full') THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.user_organizations
    WHERE organization_id=p_org AND user_id=p_actor AND role='admin') THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('review_capture:'||p_org::text,0));
  -- Mesma ordem de bloqueio do coletor: contato antes da sessão; anonimização não pode ser ignorada.
  SELECT contact_id INTO scope_contact FROM public.review_capture_sessions
    WHERE organization_id=p_org AND id=p_session AND job_id IS NULL;
  IF scope_contact IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.contacts WHERE organization_id=p_org AND id=scope_contact AND NOT is_anonymized FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.review_capture_sessions WHERE organization_id=p_org AND id=p_session FOR UPDATE;
  ts:=clock_timestamp();
  IF NOT FOUND OR NOT s.enabled OR s.stopped_reason IS NOT NULL OR s.collect_until<=ts OR
    s.contact_id IS DISTINCT FROM scope_contact OR s.job_id IS NOT NULL OR
    p_until<=s.collect_until OR p_until>s.created_at+interval '48 hours' OR
    s.reviews>=100 OR s.bytes>=10485760 OR s.last_purged_at IS NULL OR
    s.last_purged_at<=ts-interval '10 minutes' THEN RETURN NULL; END IF;
  -- Não reativa sessão, não altera criação/contadores, não muda expires_at dos registros.
  UPDATE public.review_capture_sessions SET collect_until=p_until WHERE organization_id=p_org AND id=s.id;
  INSERT INTO public.api_audit_log(organization_id,actor_user_id,action,resource_type,resource_id,metadata)
    VALUES(p_org,p_actor,'ai.review_capture_extended','review_capture',s.id,
      jsonb_build_object('scope_kind','test_contact','previous_until',s.collect_until,'collect_until',p_until,
        'max_window_hours',48,'quotas_preserved',true,'record_ttl_hours',72,'support',p_support));
  RETURN jsonb_build_object('session_id',s.id,'enabled',true,'collect_until',p_until,
    'reviews',s.reviews,'bytes',s.bytes,'record_ttl_hours',72);
END $$;
REVOKE ALL ON FUNCTION public.fn_review_capture_extend_test_contact(uuid,uuid,uuid,timestamptz,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_review_capture_extend_test_contact(uuid,uuid,uuid,timestamptz,jsonb) TO service_role;
