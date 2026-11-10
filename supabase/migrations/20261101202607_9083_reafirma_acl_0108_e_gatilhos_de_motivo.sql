-- manifest: reafirma na cadeia a ACL que a 0108 declarou para activate_kb_version (só service_role) — a 0108 não aplica sobre o baseline e o grant da 0010 sobrevivia — e tira anon das funções de gatilho de motivo de perda (0426/0513), espelhando o bloco do apêndice do baseline.
--
-- 9083 — a cadeia e a instalação chegam à mesma ACL dessas três funções.
--
-- `tests/invariants/baseline-e-cadeia-chegam-ao-mesmo-schema.test.ts` aplica a
-- cadeia sobre o baseline e compara os dois bancos. A 0108 está na lista das
-- migrations que não aplicam sobre o baseline (`rls_auto_enable` não existe),
-- então o que ela fechou em `activate_kb_version` não chegava ao caminho da
-- cadeia. Esta migration repete o fechamento.
--
-- `fn_crm_lead_close_on_stage` e `fn_validate_lost_reason_required` devolvem
-- `trigger`: o disparo de gatilho não confere EXECUTE, então `anon` não serve a
-- ninguém nelas.
--
-- Idempotente: só revoke/grant.
revoke execute on function public.activate_kb_version(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.activate_kb_version(uuid, uuid) to service_role;

revoke execute on function public.fn_crm_lead_close_on_stage() from public, anon;
grant  execute on function public.fn_crm_lead_close_on_stage() to authenticated, service_role;

revoke execute on function public.fn_validate_lost_reason_required() from public, anon;
grant  execute on function public.fn_validate_lost_reason_required() to authenticated, service_role;
