BEGIN;
CREATE TEMP SEQUENCE support_eval_calls;
CREATE OR REPLACE FUNCTION public.fn_support_context()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
SELECT jsonb_build_object('status','active','organization_id','11111111-1111-4111-8111-111111111111',
'access_mode',CASE WHEN nextval('pg_temp.support_eval_calls') > 0 THEN 'full' ELSE 'support_readonly' END);
$$;
SELECT public.fn_user_role_in_org('11111111-1111-4111-8111-111111111111');
SELECT 'evaluations='||last_value FROM support_eval_calls;
ROLLBACK;
