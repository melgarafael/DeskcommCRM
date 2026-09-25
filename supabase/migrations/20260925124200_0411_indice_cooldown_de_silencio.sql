-- 0411: índice para a consulta de cooldown do gatilho de silêncio
-- (lib/followup/silence-sweep.ts, loadContactIdsEmCooldown).
--
-- A consulta filtra followup_enrollments por (organization_id, pointer_id,
-- contact_id) e por updated_at — e roda uma vez por pointer de silêncio ATIVO
-- a cada tick do cron (1×/min, docker/scheduler/entrypoint.sh). O único índice
-- existente na tabela para (organization_id, contact_id) não cobre pointer_id.
--
-- Idempotente: `create index if not exists` — reaplicar não duplica nem falha.
create index if not exists idx_followup_enrollments_pointer_contact_cooldown
  on public.followup_enrollments (organization_id, pointer_id, contact_id, updated_at);
