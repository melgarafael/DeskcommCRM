-- 0258 — o audit log perde UPDATE, DELETE e TRUNCATE nos papéis do PostgREST
--
-- ─── O problema ─────────────────────────────────────────────────────────────
--
-- `CLAUDE.md` afirmava, sobre `api_audit_log`: "Audit é append-only, e isso é do
-- SCHEMA e não da prosa: nenhum papel tem GRANT de UPDATE/DELETE — nem
-- `service_role`". Num projeto Supabase de verdade isso era FALSO, e a primeira
-- versão desta migration (que só revogava TRUNCATE) herdou o erro.
--
-- Todo projeto Supabase nasce com um default ACL de tabelas em `public`, gravado
-- pelo bootstrap do Supabase ANTES de qualquer SQL nosso:
--
--     select pg_get_userbyid(defaclrole), defaclobjtype, defaclacl
--       from pg_default_acl where defaclnamespace = 'public'::regnamespace;
--     postgres | r | {…,anon=arwdDxt/postgres,authenticated=arwdDxt/postgres,service_role=arwdDxt/postgres}
--
-- Então `api_audit_log` nasce com TODOS os privilégios para anon, authenticated
-- e service_role. O `GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE` que o dump
-- emite para esta tabela só ACRESCENTA; não retira o UPDATE e o DELETE que o
-- default ACL já deu. Medido em 2026-09-15 no Supabase local desta máquina
-- (`supabase/postgres:15.8`), banco anterior a esta migration:
--
--     anon:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--     authenticated:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--     service_role:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--
-- ─── O que isso permitia ────────────────────────────────────────────────────
--
-- • `service_role` ignora RLS: com a service key, `DELETE /rest/v1/api_audit_log
--   ?id=eq.<x>` apagava UMA linha escolhida, e `PATCH` a reescrevia. É o pior
--   desenho para uma auditoria — adulteração seletiva, sem deixar lacuna visível.
--   Reproduzido num pg15 com o default ACL do Supabase: `set local role
--   service_role; delete from api_audit_log …` → `DELETE 1`.
-- • `anon`/`authenticated`: o GRANT existia, mas a RLS não tem policy de UPDATE
--   nem de DELETE, então a escrita casava zero linhas (`DELETE 0`). A garantia
--   ali era de UMA camada só.
-- • `TRUNCATE`, nos três: não é emitido pelo PostgREST, mas esvazia a tabela
--   inteira sem passar por RLS nem por policy.
--
-- ─── Por que o gate não viu ─────────────────────────────────────────────────
--
-- O prelude de `scripts/test-db.sh` reproduz o default ACL do Supabase para
-- FUNÇÕES, não para TABELAS. Num Postgres cru a tabela nasce só com o que o dump
-- concede, e a sonda de grants devolvia vazio medindo um universo onde o defeito
-- não existe. Quem vigia a forma do Supabase real é
-- `tests/invariants/audit-log-sob-o-default-acl-do-supabase.test.ts`, que
-- reproduz o default ACL de tabela antes de reaplicar este bloco.
--
-- ─── Por que revogar não quebra ninguém ─────────────────────────────────────
--
-- Nenhum caminho do produto altera ou apaga linha desta tabela pelos papéis do
-- PostgREST. Para conferir na fonte:
--
--     grep -rnEi "(delete|update|truncate)\s+(from\s+|table\s+)?(public\.)?api_audit_log" \
--       lib app workers supabase/baseline.sql
--     grep -rn 'from("api_audit_log")' lib app workers scripts
--
-- O único apagamento é o `delete` de dentro de `fn_expurgar_auditoria_vencida`
-- (0167), `security definer` de dono `postgres`, que não depende destes grants.
-- As FKs `on delete set null` que apontam desta tabela para `organizations`,
-- `auth.users` e `api_tokens` também não: a ação referencial roda como o dono da
-- tabela referenciante. As duas coisas são exercitadas pelo invariante acima.
--
-- `public` entra no revoke por completude: hoje ninguém concede privilégio de
-- tabela a PUBLIC aqui, mas um grant a PUBLIC seria herdado pelos três papéis.
-- O dono (`postgres`) continua podendo tudo — a garantia é sobre os papéis que
-- o PostgREST assume, nunca absoluta.
--
-- ─── Forma ──────────────────────────────────────────────────────────────────
--
-- `revoke` do que já não existe não é erro: idempotente por natureza, e o
-- `update.sh` de um clone reaplica à vontade. Portável em `psql` puro.

revoke update, delete, truncate on table public.api_audit_log
  from public, anon, authenticated, service_role;

comment on table public.api_audit_log is
  'L-10: Append-only para os papéis do PostgREST — anon, authenticated e service_role não têm UPDATE, DELETE nem TRUNCATE (migration 0258; o default ACL do Supabase concedia os três). O único apagamento é fn_expurgar_auditoria_vencida (0167), security definer com piso de 90 dias no corpo. Retencao default 5 anos, configuravel em AUDIT_LOG_RETENTION_DAYS.';

notify pgrst, 'reload schema';
