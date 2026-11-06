-- Executar somente em clone descartável sem rede. Tudo reverte ao final.
BEGIN;
SELECT set_config('request.jwt.claims','{}',true);
SELECT set_config('request.jwt.claim.sub','',true);
CREATE TEMP TABLE role_check_results(label text PRIMARY KEY, passed boolean NOT NULL);
GRANT INSERT,SELECT ON role_check_results TO authenticated,anon;
CREATE FUNCTION pg_temp.check_role(label text, actual boolean, expected boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'role assertion failed: %', label;
  END IF;
  INSERT INTO role_check_results VALUES(label,true);
END $$;
DO $$
DECLARE
  org_a uuid := gen_random_uuid(); org_b uuid := gen_random_uuid();
  actor uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  session_id uuid := gen_random_uuid(); support_id uuid;
  roles text[] := ARRAY['viewer','agent','manager','admin'];
  min_roles text[] := ARRAY['viewer','agent','manager','admin','unknown'];
  r integer; m integer;
BEGIN
  INSERT INTO organizations(id,slug,legal_name,display_name)
  VALUES(org_a,'role-a-'||org_a,'Synthetic A','Synthetic A'),
        (org_b,'role-b-'||org_b,'Synthetic B','Synthetic B');
  INSERT INTO auth.users(id,email) VALUES(actor,actor||'@example.invalid'),(outsider,outsider||'@example.invalid');
  INSERT INTO user_organizations(user_id,organization_id,role,accepted_at)
  VALUES(actor,org_a,'viewer',now());
  FOR r IN 1..4 LOOP
    PERFORM set_config('request.jwt.claims','{}',true);
    PERFORM set_config('request.jwt.claim.sub','',true);
    UPDATE user_organizations SET role=roles[r] WHERE user_id=actor AND organization_id=org_a;
    PERFORM set_config('request.jwt.claim.sub',actor::text,true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
    FOR m IN 1..5 LOOP
      PERFORM pg_temp.check_role(roles[r]||' minimum '||min_roles[m],
        fn_role_at_least(org_a,min_roles[m]),m<=4 AND r>=m);
    END LOOP;
    PERFORM pg_temp.check_role(roles[r]||' cannot access other tenant',fn_role_at_least(org_b,'viewer'),false);
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  PERFORM pg_temp.check_role('nonmember denied',fn_role_at_least(org_a,'viewer'),false);
  PERFORM set_config('request.jwt.claims','{}',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  UPDATE user_organizations SET revoked_at=now() WHERE user_id=actor AND organization_id=org_a;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  PERFORM pg_temp.check_role('revoked admin denied',fn_role_at_least(org_a,'viewer'),false);
  PERFORM set_config('request.jwt.claims','{}',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM pg_temp.check_role('anonymous denied',fn_role_at_least(org_a,'viewer'),false);
  UPDATE user_organizations SET revoked_at=null,role='agent' WHERE user_id=actor AND organization_id=org_a;
  INSERT INTO auth.sessions(id,user_id) VALUES(session_id,actor);
  INSERT INTO platform_admins(user_id,granted_by,reason,scope,mfa_required)
  VALUES(actor,actor,'Synthetic role regression','full',false);
  INSERT INTO platform_support_sessions(organization_id,actor_user_id,auth_session_id,access_mode,expires_at)
  VALUES(org_b,actor,session_id,'full',now()+interval '10 minutes') RETURNING id INTO support_id;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','session_id',session_id,'aal','aal2')::text,true);
  PERFORM pg_temp.check_role('authorized full support has admin in target',fn_role_at_least(org_b,'admin'),true);
  PERFORM pg_temp.check_role('support preserves ordinary tenant role',fn_role_at_least(org_a,'manager'),false);
  UPDATE platform_support_sessions SET access_mode='support_readonly' WHERE id=support_id;
  PERFORM pg_temp.check_role('readonly support can read target',fn_role_at_least(org_b,'viewer'),true);
  PERFORM pg_temp.check_role('readonly support cannot become agent',fn_role_at_least(org_b,'agent'),false);
  PERFORM pg_temp.check_role('readonly support still cannot write',fn_support_write_allowed(org_b),false);
  UPDATE platform_support_sessions SET expires_at=now()-interval '1 second' WHERE id=support_id;
  PERFORM pg_temp.check_role('expired support denied',fn_role_at_least(org_b,'viewer'),false);
  PERFORM set_config('role_test.org_a',org_a::text,true);
  PERFORM set_config('role_test.org_b',org_b::text,true);
END $$;
SET LOCAL ROLE authenticated;
SELECT pg_temp.check_role('authenticated caller has agent in own tenant',
  fn_role_at_least(current_setting('role_test.org_a')::uuid,'agent'),true);
SELECT pg_temp.check_role('authenticated caller is not manager',
  fn_role_at_least(current_setting('role_test.org_a')::uuid,'manager'),false);
SELECT pg_temp.check_role('authenticated caller has no expired support access',
  fn_role_at_least(current_setting('role_test.org_b')::uuid,'viewer'),false);
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.fn_role_at_least(current_setting('role_test.org_a')::uuid,'viewer');
    RAISE EXCEPTION 'anonymous execution unexpectedly granted';
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM pg_temp.check_role('anonymous cannot execute helper',true,true);
  END;
END $$;
RESET ROLE;
SELECT json_build_object('passed',count(*),'all_passed',bool_and(passed)) FROM role_check_results;
ROLLBACK;
