-- manifest: **`/admin/extensoes` — o rótulo estável da empresa e o "lido em" no fuso dela (#5097).** Redefine `fn_extensions_events_lag(p_installation)` para devolver, por vínculo, `rotulo` — os 6 primeiros caracteres do `md5` do id da organização — e `fuso` (o `organizations.timezone` dela), junto dos números e datas que ela já devolvia. O rótulo sai do HASH, nunca da posição: a lista é ordenada por atraso e a empresa que acabou de ler muda de lugar, então índice não identifica ninguém entre duas aberturas da tela nem entre dois dias. Nome e id da organização continuam não saindo da função (6 hex não reconstroem o uuid), e o fuso é o que faz o "lido em" sair na hora de quem opera, não na do servidor. Espelho idempotente no apêndice do `supabase/baseline.sql`, no bloco da 9446. Prova em `tests/unit/extensoes-rotulo-estavel-do-modulo.test.ts`.
-- ============================================================================
-- 9507 — EXTENSÕES: O RÓTULO DA EMPRESA NÃO DEPENDE DA ORDEM DA LISTA.
--
-- O defeito era de tela (o índice da lista virava nome), mas o conserto não
-- cabe na tela: a função do atraso NÃO devolvia nada que identificasse a
-- organização — por desenho, para o dono do servidor não ver a lista de
-- clientes. Sem uma âncora estável, a tela só tem a posição para numerar.
--
-- A âncora é o HASH do id, e ele é calculado AQUI, não no app: assim o uuid da
-- organização continua não saindo da função (a cerca de
-- `tests/invariants/extensoes-eventos.test.ts` cobra isso), e o que chega à
-- tela — seis caracteres hexadecimais — não reconstroi nome nem id.
-- `md5` mora no `pg_catalog`, então o `search_path = ''` não a esconde.
--
-- O `fuso` entra pelo mesmo motivo: o "lido em" era formatado no fuso do
-- processo (UTC na instalação padrão), e quem administra de São Paulo via a
-- hora três horas à frente. É o mesmo `organizations.timezone` que o resto do
-- app usa para virar o dia.
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
    select o.organization_id, g.timezone, c.last_event_id, c.last_read_at,
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
      join public.organizations g on g.id = o.organization_id
      left join public.extension_module_cursors c
        on c.installation_id = p_installation and c.organization_id = o.organization_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'rotulo', substr(md5(l.organization_id::text), 1, 6), 'fuso', l.timezone,
           'last_event_id', l.last_event_id, 'last_read_at', l.last_read_at, 'lag', l.lag,
           'contacts_pending', l.contacts_pending, 'oldest_unread_at', l.oldest_unread_at
         ) order by l.lag desc, l.last_read_at nulls first), '[]'::jsonb)
    from linhas l;
$$;

revoke execute on function public.fn_extensions_events_lag(uuid) from public, anon, authenticated;
grant execute on function public.fn_extensions_events_lag(uuid) to service_role;

notify pgrst, 'reload schema';
