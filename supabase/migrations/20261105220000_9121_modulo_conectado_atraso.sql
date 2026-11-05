-- manifest: **Módulo conectado, F5 T3 — o atraso do módulo, para `/admin/extensoes`.** Função `fn_extensions_events_lag(p_installation)` (`security invoker`, `search_path` vazio, EXECUTE só `service_role`): para cada organização com vínculo ligado OU cursor desta instalação devolve, SEM identificar a organização, `last_event_id` e `last_read_at` (nulos se nunca leu), `lag` (eventos da MESMA organização com `id` maior que o cursor; `module_disabled` só deste par), `contacts_pending` (os `contact_anonymized` ainda não lidos) e `oldest_unread_at`. A contagem é por organização e nunca mistura organizações. Espelho idempotente no apêndice do `supabase/baseline.sql`, depois da 9120. Prova em `tests/invariants/extensoes-eventos.test.ts` e `lib/extensions/eventos-do-modulo.test.ts`.
-- ============================================================================
-- 9121 — MÓDULO CONECTADO, F5 T3: o atraso do módulo.
-- ============================================================================

create or replace function public.fn_extensions_events_lag(p_installation uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with orgs as (
    select e.organization_id from public.organization_extensions e
      where e.installation_id = p_installation and e.enabled
    union
    select c.organization_id from public.extension_module_cursors c
      where c.installation_id = p_installation
  ), linhas as (
    select o.organization_id, c.last_event_id, c.last_read_at,
           (select count(*) from public.extension_module_events v
              where v.organization_id = o.organization_id and v.id > coalesce(c.last_event_id, 0)
                and (v.kind <> 'module_disabled' or v.installation_id = p_installation)) as lag,
           (select count(*) from public.extension_module_events v
              where v.organization_id = o.organization_id and v.id > coalesce(c.last_event_id, 0)
                and v.kind = 'contact_anonymized') as contacts_pending,
           (select min(v.occurred_at) from public.extension_module_events v
              where v.organization_id = o.organization_id and v.id > coalesce(c.last_event_id, 0)
                and (v.kind <> 'module_disabled' or v.installation_id = p_installation)) as oldest_unread_at
      from orgs o
      left join public.extension_module_cursors c
        on c.installation_id = p_installation and c.organization_id = o.organization_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'last_event_id', l.last_event_id, 'last_read_at', l.last_read_at, 'lag', l.lag,
           'contacts_pending', l.contacts_pending, 'oldest_unread_at', l.oldest_unread_at
         ) order by l.lag desc, l.last_read_at nulls first), '[]'::jsonb)
    from linhas l;
$$;

revoke execute on function public.fn_extensions_events_lag(uuid) from public, anon, authenticated;
grant execute on function public.fn_extensions_events_lag(uuid) to service_role;

notify pgrst, 'reload schema';
