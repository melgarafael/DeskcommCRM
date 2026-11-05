-- manifest: **Nome de atendente só para quem tem vínculo com a organização:** zera `conversations.assigned_to_user_name` onde `assigned_to_user_id` não tem (nem teve) linha em `user_organizations` com a `organization_id` da conversa — sem filtro de `revoked_at`, ex-membro mantém o nome. O backfill da 0202 no apêndice do `supabase/baseline.sql` passa a exigir o mesmo vínculo. Forward-fix de dado, sem mudança de schema e sem função nova. Idempotente (bloco DO); espelho no fim do apêndice do baseline.
-- ============================================================================
-- 9219 — NOME DE ATENDENTE SÓ COM VÍNCULO COM A ORGANIZAÇÃO.
--
-- Regra: o nome de quem atende só se resolve para quem tem ou teve vínculo com
-- a organização (a mesma de lib/users/nome-do-atendente.ts). Esta migration
-- zera a cópia desnormalizada nas linhas fora da regra. A segunda passada não
-- acha linha.
-- ============================================================================

do $$
begin
  update public.conversations c
     set assigned_to_user_name = null
   where c.assigned_to_user_name is not null
     and not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = c.assigned_to_user_id
          and uo.organization_id = c.organization_id
     );
end $$;
