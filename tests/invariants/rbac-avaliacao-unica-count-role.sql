BEGIN;
CREATE TEMP SEQUENCE role_eval_calls;
CREATE OR REPLACE FUNCTION public.fn_user_role_in_org(p_org uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
SELECT CASE WHEN nextval('pg_temp.role_eval_calls') > 0 THEN 'agent'::text ELSE NULL END;
$$;
SELECT public.fn_role_at_least('11111111-1111-4111-8111-111111111111','agent');
SELECT 'evaluations='||last_value FROM role_eval_calls;
ROLLBACK;
