-- Somente laboratório descartável. DDL de spies é transacional e reverte.
BEGIN;
CREATE TEMP SEQUENCE visibility_role_calls;
CREATE TEMP TABLE visibility_results(label text, passed boolean);
CREATE OR REPLACE FUNCTION public.fn_user_role_in_org(p_org uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
SELECT CASE WHEN nextval('pg_temp.visibility_role_calls') > 0
 THEN nullif(current_setting('test.visibility_role',true),'') END;
$$;
CREATE OR REPLACE FUNCTION public.fn_is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
SELECT coalesce(nullif(current_setting('test.visibility_master',true),'')::boolean,false);
$$;
DO $$BEGIN PERFORM set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111"}',true); END;$$;
SELECT set_config('test.visibility_master','false',true);
-- Papel inexistente não lê a organização; agent próprio não precisa de settings.
SELECT set_config('test.visibility_role','',true);
INSERT INTO visibility_results SELECT 'lead sem membership',not public.fn_can_view_lead('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null);
INSERT INTO visibility_results SELECT 'conversa sem membership',not public.fn_can_view_conversation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',null);
SELECT set_config('test.visibility_role','agent',true);
INSERT INTO visibility_results SELECT 'lead próprio',public.fn_can_view_lead('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111');
INSERT INTO visibility_results SELECT 'conversa própria',public.fn_can_view_conversation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111');
DO $test$
DECLARE helper text; role_name text; owner_id uuid; actual boolean; expected boolean; n bigint; mode_name text;
BEGIN
 INSERT INTO public.organizations(id,slug,legal_name,display_name,settings) VALUES('a3882000-0000-4000-8000-000000000001','visibility-3882-test','Synthetic visibility test','Synthetic visibility test','{}');
 FOREACH helper IN ARRAY ARRAY['fn_can_view_lead','fn_can_view_conversation'] LOOP
  FOREACH role_name IN ARRAY ARRAY['viewer','agent','manager','admin','unknown',''] LOOP
   PERFORM set_config('test.visibility_role',role_name,true);
   FOREACH mode_name IN ARRAY ARRAY['own','own_and_unassigned','all'] LOOP
   UPDATE public.organizations SET settings=jsonb_build_object('visibility_mode',mode_name) WHERE id='a3882000-0000-4000-8000-000000000001';
   FOREACH owner_id IN ARRAY ARRAY[null::uuid,'11111111-1111-4111-8111-111111111111'::uuid,'22222222-2222-4222-8222-222222222222'::uuid] LOOP
    -- Organização sintética: compara os três modos sem ler dados reais.
    expected := CASE WHEN role_name='' THEN false WHEN role_name IN('viewer','manager','admin') THEN true WHEN owner_id='11111111-1111-4111-8111-111111111111' THEN true ELSE CASE mode_name WHEN 'all' THEN true WHEN 'own_and_unassigned' THEN owner_id IS NULL ELSE false END END;
    EXECUTE format('SELECT public.%I($1,$2)',helper) INTO actual USING 'a3882000-0000-4000-8000-000000000001'::uuid,owner_id;
    INSERT INTO visibility_results VALUES(helper||':'||mode_name||':'||role_name||':'||coalesce(owner_id::text,'null'),actual IS NOT DISTINCT FROM expected);
   END LOOP;
   END LOOP;
  END LOOP;
  PERFORM set_config('test.visibility_role','agent',true);
  ALTER SEQUENCE visibility_role_calls RESTART WITH 1;
  EXECUTE format('SELECT public.%I($1,$2)',helper) INTO actual USING 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,'11111111-1111-4111-8111-111111111111'::uuid;
  SELECT last_value INTO n FROM visibility_role_calls;
  INSERT INTO visibility_results VALUES(helper||':papel uma vez',n=1);
  -- Master não chama helper de papel nem quando o papel não existe.
  PERFORM set_config('test.visibility_master','true',true);
  ALTER SEQUENCE visibility_role_calls RESTART WITH 1;
  EXECUTE format('SELECT public.%I($1,$2)',helper) INTO actual USING 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,null::uuid;
  INSERT INTO visibility_results SELECT helper||':master curto circuito',actual AND NOT is_called FROM visibility_role_calls;
  PERFORM set_config('test.visibility_master','false',true);
 END LOOP;
END;$test$;
SELECT json_build_object('checks',count(*),'failures',count(*)FILTER(WHERE NOT passed),'failed_labels',coalesce(json_agg(label)FILTER(WHERE NOT passed),'[]'::json))FROM visibility_results;
ROLLBACK;
