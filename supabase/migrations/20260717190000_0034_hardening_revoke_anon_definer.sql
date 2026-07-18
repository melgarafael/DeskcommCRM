-- 0034_hardening_revoke_anon_definer
-- G4-00 (gov-loop): defesa em profundidade (INB-07) — nega EXECUTE a `anon` em
-- 6 funções SECURITY DEFINER de ESCRITA. Duas origens de grant a anon (por isso
-- dois padrões de fechamento):
--
--   A) fn_upsert_wa_contact / fn_upsert_wa_conversation / fn_mark_conversation_message
--      já têm `revoke all from public` no baseline; anon herda EXECUTE só do
--      ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon (paridade
--      Supabase). Fechamento: `revoke execute ... from anon`.
--
--   B) emit_event / fn_log_event / fn_audit_log_row foram criadas ANTES do ALTER
--      DEFAULT PRIVILEGES e NUNCA tiveram `revoke ... from public` — anon herda
--      EXECUTE via PUBLIC (grant default do Postgres a toda função nova). Aqui o
--      `revoke from anon` não basta: é preciso `revoke execute ... from public`
--      e re-afirmar os grants explícitos de authenticated/service_role (os
--      call sites legítimos), sem tocar nesses dois papéis.
--
-- Auditoria de call sites (nenhum fluxo anônimo depende delas):
--   A → lib/waha/ingest.ts via admin.rpc (service_role, após HMAC do webhook WAHA);
--   emit_event → admin.rpc (workers/webhooks/ingest, service_role) e .rpc em
--     rotas autenticadas (authenticated);
--   fn_log_event / fn_audit_log_row → só invocadas por triggers (nenhum call site TS;
--     trigger não checa EXECUTE do papel que dispara a DML).
--
-- Idempotente (revoke é no-op sem grant; grant re-afirma), portável em psql puro
-- (sem BEGIN/COMMIT, sem temp tables). Assinatura exata exigida pelo revoke.

-- A) grant direto de anon (ALTER DEFAULT PRIVILEGES): revoke anon.
revoke execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from anon;
revoke execute on function public.fn_upsert_wa_conversation(uuid, uuid, uuid) from anon;
revoke execute on function public.fn_mark_conversation_message(uuid, text, text, timestamptz) from anon;

-- B) anon herda de PUBLIC: revoke public (+ anon por garantia) e re-afirma
--    authenticated/service_role (os únicos papéis dos call sites legítimos).
revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from public;
revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) from anon;
grant execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;

revoke execute on function public.fn_log_event(uuid, text, jsonb) from public;
revoke execute on function public.fn_log_event(uuid, text, jsonb) from anon;
grant execute on function public.fn_log_event(uuid, text, jsonb) to authenticated, service_role;

revoke execute on function public.fn_audit_log_row() from public;
revoke execute on function public.fn_audit_log_row() from anon;
grant execute on function public.fn_audit_log_row() to service_role;
