-- 0167 — corrige idempotência de `payments_select` (migration 0162): faltava
-- `drop policy if exists` antes do `create policy`, então reaplicar o
-- baseline.sql num banco que já tem a 0162 (é o que self-host-kit/update.sh
-- faz em toda instalação existente) falhava com "policy already exists".
-- Achado por pnpm test:db (passe de update, ON_ERROR_STOP=1) — mesma classe
-- de bug crítico de instalação que a migration 0165/0166 tiveram, mas esta
-- (0162) já está em main e pode já ter sido aplicada por algum self-hoster:
-- forward-fix, não edição da migration original.

drop policy if exists "payments_select" on public.payments;
create policy payments_select on public.payments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
