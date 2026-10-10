-- 0115 — duas entidades que não se conseguia apagar.
--
-- Achados ao remover as fixtures de E2E da produção em 2026-08-06. Os dois são
-- da mesma família: uma escrita AUTOMÁTICA (trigger/FK) reagindo ao DELETE e
-- violando uma regra que vale para o estado normal, mas não para a remoção.
--
-- ═══ DEFEITO 1 · não era possível apagar uma ORGANIZAÇÃO ═══
--
--   ERROR: insert or update on table "api_audit_log" violates foreign key
--          constraint "api_audit_log_organization_id_fkey"
--   DETAIL: Key (organization_id)=(…) is not present in table "organizations".
--
-- O cascade apaga os filhos, o trigger de audit de cada um insere em
-- `api_audit_log` com o `organization_id` — e a organização já não existe. Só
-- funcionava apagando os filhos à mão ANTES, com o pai vivo.
--
-- Conserto: no DELETE, o audit é pulado quando a organização já não existe. Não
-- se perde auditoria: a linha que ele escreveria seria apagada pelo cascade da
-- própria organização um instante depois. E a checagem fica SÓ no ramo DELETE —
-- pôr um `exists` no INSERT/UPDATE cobraria um SELECT em todo hot path de
-- escrita para proteger de um caso que não acontece lá.
--
-- ═══ DEFEITO 2 · não era possível apagar um AGENTE que já atendeu ═══
--
--   ERROR: new row for relation "crm_leads" violates check constraint
--          "crm_leads_owner_kind_coherence"
--
-- `crm_leads_owner_agent_id_fkey` é ON DELETE SET NULL; o CHECK exige
-- `owner_agent_id not null` quando `owner_kind = 'ai'`. O SET NULL zera um lado
-- e deixa o outro — estado que a constraint proíbe, com razão.
--
-- Conserto: um BEFORE DELETE em `ai_agents` desfaz a atribuição INTEIRA (os dois
-- campos), antes de a FK agir. O lead fica sem dono (`owner_kind is null`, que o
-- CHECK aceita) em vez de ficar num estado meio-atribuído.
--
-- Não se enfraquece o CHECK para tolerar `'ai'` sem agente: ele descreve um
-- invariante verdadeiro, e afrouxá-lo para acomodar uma operação rara trocaria
-- um erro barulhento por dados incoerentes em silêncio.

-- ── 1 · o audit não persegue uma organização que está sendo removida ────────
create or replace function public.fn_audit_log_row() returns trigger
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
  v_action text;
  v_org    uuid;
begin
  if tg_op = 'INSERT' then
    v_action := tg_table_name || '.created';
    v_org    := new.organization_id;
  elsif tg_op = 'UPDATE' then
    v_action := tg_table_name || '.updated';
    v_org    := new.organization_id;
  elsif tg_op = 'DELETE' then
    v_action := tg_table_name || '.deleted';
    v_org    := old.organization_id;

    -- A organização está indo embora (cascade em curso). Registrar a exclusão
    -- de um filho num tenant que deixa de existir não tem consumidor: a linha
    -- seria apagada pelo cascade em seguida — e tentar escrevê-la aborta a
    -- transação inteira, que era o defeito.
    --
    -- SÓ no ramo DELETE: um `exists` no INSERT/UPDATE cobraria um SELECT em
    -- todo hot path de escrita para cobrir um caso que não ocorre lá.
    if v_org is not null and not exists (select 1 from public.organizations where id = v_org) then
      return old;
    end if;
  end if;

  insert into public.api_audit_log (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_org,
    auth.uid(),
    v_action,
    tg_table_name,
    coalesce(new.id, old.id),
    case when tg_op = 'UPDATE'
      then jsonb_build_object('changed_fields', '[diff suppressed in v0.1]')
      else '{}'::jsonb
    end
  );

  return coalesce(new, old);
end $$;

-- ── 2 · apagar um agente desfaz a atribuição inteira, não metade dela ───────
create or replace function public.fn_liberar_leads_do_agente() returns trigger
    language plpgsql security definer
    set search_path to 'public'
    as $$
begin
  -- ANTES de a FK aplicar seu SET NULL. Zera os DOIS campos: deixar
  -- `owner_kind = 'ai'` com o agente nulo é exatamente o estado que
  -- `crm_leads_owner_kind_coherence` proíbe.
  update public.crm_leads
     set owner_agent_id = null,
         owner_kind     = null
   where owner_agent_id = old.id;
  return old;
end $$;

-- As TRÊS origens de EXECUTE (CLAUDE.md, doutrina de migrations):
--   `public`      — o grant que o Postgres dá a toda função ao criá-la;
--   `anon`        — o ALTER DEFAULT PRIVILEGES do baseline, que alcança toda
--                   função criada depois dele;
--   `authenticated` — idem, e é o que a varredura de hardening cobra.
--
-- Revogar de todas é seguro AQUI porque o único call site é o TRIGGER, e o
-- Postgres não exige EXECUTE do usuário para invocar função de trigger. Nenhuma
-- sessão chama esta função diretamente.
revoke execute on function public.fn_liberar_leads_do_agente() from public, anon, authenticated;
grant  execute on function public.fn_liberar_leads_do_agente() to service_role;

drop trigger if exists trg_liberar_leads_do_agente on public.ai_agents;
create trigger trg_liberar_leads_do_agente
  before delete on public.ai_agents
  for each row execute function public.fn_liberar_leads_do_agente();

comment on function public.fn_liberar_leads_do_agente() is
  'Migration 0115: desfaz a atribuição de leads antes de o agente ser apagado. '
  'Sem isto o SET NULL da FK zera owner_agent_id e deixa owner_kind=''ai'', '
  'violando crm_leads_owner_kind_coherence — e um agente que já atendeu alguém '
  'não podia ser removido.';
