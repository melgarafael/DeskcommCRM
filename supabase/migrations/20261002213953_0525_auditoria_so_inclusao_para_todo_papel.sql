-- Migration 0525 — o audit log é só-inclusão para todo papel que não seja o dono.
--
-- Mesmo corpo que o apêndice do baseline.sql (rótulo da migration 0525).

-- A 0258 tirou UPDATE, DELETE e TRUNCATE de `api_audit_log` numa lista FIXA de
-- papéis: public, anon, authenticated e service_role. Papel criado pelo
-- operador ficava de fora — e o README do self-host manda criar um, o
-- `agent_worker`, com `grant select, insert, update, delete on all tables`.
-- O `update.sh` re-aplicava a 0258 sem alcançar esse papel.
--
-- Este bloco troca a lista por uma regra: todo papel com grant DIRETO de
-- UPDATE, DELETE ou TRUNCATE em `api_audit_log`, exceto o dono da tabela,
-- perde os três. Com o nome que o operador tiver dado ao papel. INSERT e
-- SELECT ficam — o worker grava auditoria e a lê.
--
-- O dono fica de fora porque o privilégio dele é implícito (revogar não o
-- alcança) e porque o expurgo legítimo, `fn_expurgar_auditoria_vencida`
-- (0167), é `security definer` dele, assim como as FKs `on delete set null`.
--
-- Idempotente: na segunda passada o laço não acha ninguém. Roda a cada
-- `update.sh`, então uma instalação que já seguiu a receita antiga se cura na
-- próxima atualização. Sem função nova (nada a revogar de anon).

do $$
declare
  v_papel text;
begin
  for v_papel in
    select distinct case when a.grantee = 0 then 'public' else quote_ident(r.rolname) end
      from pg_class c
      cross join lateral aclexplode(c.relacl) a
      left join pg_roles r on r.oid = a.grantee
     where c.oid = 'public.api_audit_log'::regclass
       and a.grantee <> c.relowner
       and a.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
  loop
    execute format('revoke update, delete, truncate on table public.api_audit_log from %s', v_papel);
  end loop;
end
$$;
