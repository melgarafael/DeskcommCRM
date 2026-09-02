-- 0168 — POLICY payments_select GANHA GUARDA DE IDEMPOTÊNCIA.
--
-- Achado ao validar a 0167: a migration 0162 (pagamentos PaySuite) cria a
-- policy `payments_select` sem `drop policy if exists` antes — toda outra
-- policy do baseline segue esse padrão, esta ficou de fora. Sem a guarda,
-- reaplicar o baseline (o que `update.sh` faz em toda instalação existente)
-- quebra com "policy already exists" assim que a 0162 tiver rodado uma vez.
--
-- Não muda a definição da policy — só a torna re-aplicável.

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
