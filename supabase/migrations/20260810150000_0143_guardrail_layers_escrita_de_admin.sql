-- ============================================================================
-- 0143 — DESLIGAR UMA CAMADA DE SEGURANÇA É AÇÃO DE ADMIN, NO BANCO
--
-- Forward-fix da 0142, que criou `public.org_guardrail_layers` com UMA policy
-- `for all` org-flat e deixou o único gate de papel na rota
-- (`admin` no PUT de `app/api/v1/ai/guardrail-layers/route.ts`).
--
-- ROTA NÃO É FRONTEIRA. O `baseline.sql` tem
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`, e isso
-- vale para toda tabela criada DEPOIS dele — inclusive esta. Então, com a anon key
-- (que vai para o browser) e o próprio JWT, qualquer membro da organização escrevia
-- direto pelo PostgREST, sem passar pela rota e sem deixar linha de auditoria (o
-- `audit()` vive na rota).
--
-- Medido num pg17 do zero com o baseline aplicado: um `viewer` desligou `jailbreak` e
-- gravou `promessa_semantica = false` — UPDATE 1 + INSERT 1. O papel mais baixo do
-- produto desarmando a defesa anti-manipulação da organização.
--
-- O raciocínio que produziu o furo estava escrito na própria 0142: "nenhuma função
-- nova, então não há grant a revogar". A doutrina de revoke do CLAUDE.md fala de
-- FUNÇÃO, e ausência de função foi lida como ausência de exposição. Tabela nova também
-- nasce concedida, pelo mesmo ALTER DEFAULT PRIVILEGES.
--
-- Forma canônica do repo (ver `crm_stages_select` / `crm_stages_manager_write` no
-- apêndice do baseline): uma policy de LEITURA org-flat e uma de ESCRITA com
-- `fn_role_at_least`. A leitura fica org-flat por precedência declarada do repo — o
-- `manager` exigido no GET é gate de TELA, e tela que oferece menos que o banco permite
-- é decisão de produto, não brecha entre clientes.
--
-- Por que forward-fix e não edição da 0142: a 0142 foi publicada na `main` (PR #218,
-- merge 1067c46b, 2026-08-10T14:41Z) antes deste conserto. Clone que já a aplicou não
-- re-executa arquivo editado — o Supabase CLI marca a versão como aplicada pelo nome.
-- A correção precisa chegar como versão NOVA.
--
-- Idempotente e auto-curativo: derruba as três policies por nome antes de criar, então
-- serve tanto para quem está na 0142 quanto para quem já rodou este arquivo.
-- ============================================================================

alter table public.org_guardrail_layers enable row level security;

drop policy if exists tenant_isolation_org_guardrail_layers_all on public.org_guardrail_layers;
drop policy if exists org_guardrail_layers_select on public.org_guardrail_layers;
drop policy if exists org_guardrail_layers_admin_write on public.org_guardrail_layers;

create policy org_guardrail_layers_select on public.org_guardrail_layers
  for select using (
    (organization_id in (select public.fn_user_org_ids()))
    or public.fn_is_platform_admin()
  );

create policy org_guardrail_layers_admin_write on public.org_guardrail_layers
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'admin'))
  );

-- `anon` não tem organização, então a RLS já devolveria zero linha. Revoga-se de todo
-- jeito, seguindo o precedente da 0123 (`contact_field_proposals`): defesa que não
-- depende de uma única camada custa menos que a investigação de quando ela falhar.
revoke all on public.org_guardrail_layers from anon;
